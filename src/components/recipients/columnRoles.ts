/**
 * Column retention + role designation — pure core (PRD `prd-bad-debt-excel-campaign.md`, issue #65).
 *
 * This is the load-bearing reversal of the uploaded-file model. Where
 * {@link ./extractContactIds} treats an upload as *only* a bag of contact GUIDs —
 * finding one id column and discarding every other — this module keeps **every
 * column** so the uploaded file can become the source of truth for message
 * content. The extractor changes; the `.xlsx`/`.csv` reader is reused unchanged.
 *
 * Two pure steps:
 *
 *   1. {@link parseUploadedColumns} — parsed rows (first row = header) →
 *      `{ columns, dataRows }`, every header surfaced and every data row padded
 *      to the header width so cell access by column index is always safe.
 *   2. {@link materialiseRecipients} — `(columns, dataRows)` + the operator's
 *      {@link ColumnRoles} designation → recipients, each keyed by its
 *      **tracking-key value** (filling the existing `recipientId` slot so the
 *      one-message-per-`(campaign, recipient)` idempotency seam keeps working
 *      unchanged) and carrying a **variables bag** of that row's full cell data
 *      for the merge engine (#66) to consume.
 *
 * Identity is the tracking-key column value, normalised as a GUID (reusing
 * {@link normaliseContactId}). The single-outstanding-invoice rule is a hard
 * gate, not a guess: a row whose tracking key is blank/malformed is **held**,
 * and — because two rows sharing a tracking key means a contact with more than
 * one invoice — **every** row sharing a duplicated key is held too, never
 * silently collapsed. Held rows feed the pre-send validation report (#67).
 *
 * Everything here is pure — no File, no FileReader — so the decision logic is
 * the test surface, exactly as for `extractContactIds`. A thin impure reader
 * (`readUploadedColumnsFromFile`) feeds rows in.
 */

import { normaliseContactId, type DetectedColumn } from "./extractContactIds";
import {
    buildValidationReport,
    type PdfStatus,
    type ValidationReport,
} from "./validationReport";
import type { TemplateVariableField } from "./whatsappVariableMapping";

export type UploadedColumnsStatus =
    | "ok" // the file had a header row (dataRows may still be empty)
    | "empty"; // the file had no rows at all

export interface UploadedColumns {
    status: UploadedColumnsStatus;
    /** Every column header (trimmed), in file order. */
    columns: DetectedColumn[];
    /** Data rows (header stripped), each padded to `columns.length` cells. */
    dataRows: string[][];
}

/**
 * Which uploaded column plays which role, by column index. The operator
 * designates these per upload; they are persisted per campaign.
 *
 * - `sendAddress` — the email column an email campaign sends to (null when not
 *   designated, e.g. a WhatsApp upload that maps a phone column instead).
 * - `trackingKey` — the contact-GUID column that is the recipient's identity.
 *   Required: identity is the whole point of the seam.
 * - `invoiceGuid` — the column holding the invoice GUID used to fetch each
 *   recipient's PDF (null until the PDF slice; not every campaign attaches one).
 * - `ccAddress` — the column naming a per-recipient consultant email to CC
 *   (null when not designated). No dedicated per-recipient field: the cell
 *   already travels in the variables bag; this role only records *which header*
 *   is the CC (PRD #78, issue #79).
 * - `phone` — the column holding each recipient's mobile number, the WhatsApp
 *   send destination (null when not designated). Distinct from `sendAddress`
 *   (email): designating one never populates the other (PRD #84, issue #85).
 */
export interface ColumnRoles {
    sendAddress: number | null;
    trackingKey: number;
    invoiceGuid: number | null;
    ccAddress: number | null;
    phone: number | null;
}

/**
 * The role designation as it is **persisted on the campaign** (schema
 * `campaigns.columnRoles`): each role names a **column header**, not an index.
 * Naming headers (rather than indices) is what makes the designation durable
 * across a re-export that reorders or re-labels columns — the same headers
 * re-resolve to whatever positions they now occupy. Optional roles are absent,
 * null, or blank when the operator did not designate them.
 */
export interface PersistedColumnRoles {
    sendAddress?: string | null;
    trackingKey: string;
    invoiceGuid?: string | null;
    ccAddress?: string | null;
    phone?: string | null;
}

/** One designated role whose persisted header is not among the uploaded columns. */
export interface UnresolvedRole {
    role: keyof PersistedColumnRoles;
    /** The (trimmed) header that was designated but not found. */
    header: string;
}

export type ResolveColumnRolesResult =
    | { status: "ok"; roles: ColumnRoles }
    | { status: "unresolved"; unresolved: UnresolvedRole[] };

export interface MaterialisedRecipient {
    /**
     * 0-based index of this row in the upload's data rows (excludes the header),
     * so the pre-send validation report (#67) can point the operator at the exact
     * row a content hold came from.
     */
    rowIndex: number;
    /**
     * The recipient's identity: the tracking-key cell, normalised to a canonical
     * GUID. Fills the existing `recipientId` slot so the idempotency/eligibility
     * seam operates unchanged against uploaded rows.
     */
    recipientId: string;
    /** The send-address cell (trimmed), or null when no send-address role. */
    sendAddress: string | null;
    /** The invoice-GUID cell (trimmed), or null when no invoice-GUID role. */
    invoiceGuid: string | null;
    /**
     * The phone cell (trimmed), or null when no phone role. This is the WhatsApp
     * send destination for an uploaded recipient (PRD #84, issue #85).
     */
    phone: string | null;
    /**
     * This row's full cell data as `{ header: cell }` — the per-recipient merge
     * variables bag the email/WhatsApp adapters consume. Headers are trimmed
     * (they are what a `{placeholder}` binds to); cell values are kept exactly as
     * uploaded, since the merge is flat substitution with no formatting.
     */
    variables: Record<string, string>;
}

export type HeldReason =
    | "missing-tracking-key" // the tracking-key cell is blank or not a GUID
    | "duplicate-tracking-key"; // the tracking key is shared with another row (multi-invoice contact)

export interface HeldRow {
    /** 0-based index into `dataRows` (excludes the header row). */
    rowIndex: number;
    reason: HeldReason;
    /**
     * The offending tracking-key cell: the normalised GUID for a duplicate, or
     * the raw (trimmed) cell for a missing/malformed key.
     */
    trackingKey: string;
}

export interface MaterialiseResult {
    /** Rows that became recipients, in first-seen order. */
    recipients: MaterialisedRecipient[];
    /** Rows held out (blank/malformed key, or a duplicated key), for the report. */
    held: HeldRow[];
}

/**
 * Parse already-read rows (first row = header) into retained columns + padded
 * data rows. An empty file yields `empty`; a headers-only file yields `ok` with
 * an empty `dataRows`.
 */
export function parseUploadedColumns(rows: string[][]): UploadedColumns {
    if (rows.length === 0) {
        return { status: "empty", columns: [], dataRows: [] };
    }

    const [header, ...rest] = rows;
    const columns = header.map((cell, index): DetectedColumn => ({ index, header: cell.trim() }));
    const dataRows = rest.map((row) =>
        columns.map((_, index) => row[index] ?? ""),
    );

    return { status: "ok", columns, dataRows };
}

/**
 * Bridge the campaign's **persisted (header-keyed)** role designation to the
 * **index-keyed** {@link ColumnRoles} that {@link materialiseRecipients}
 * consumes, resolved against the columns as read back from the (possibly
 * re-exported) upload. This is the AC #4 → #5 link: roles are stored by header
 * so they survive a re-export, and re-resolved to indices at send time.
 *
 * Each designated header is matched (after trimming) against the already-trimmed
 * column headers; a duplicated header resolves to its **first** occurrence.
 * Optional roles left unset (absent / null / blank) resolve to `null`. If the
 * required `trackingKey` header — or any designated optional header — is not
 * present among the columns, the result is `unresolved`, listing each missing
 * role in `sendAddress, trackingKey, invoiceGuid, ccAddress, phone` order, so the
 * caller can hold the upload rather than materialise against the wrong columns.
 */
export function resolveColumnRoles(
    columns: DetectedColumn[],
    persisted: PersistedColumnRoles,
): ResolveColumnRolesResult {
    const unresolved: UnresolvedRole[] = [];

    const resolve = (role: keyof PersistedColumnRoles, header: string): number | null => {
        const wanted = header.trim();
        const column = columns.find((c) => c.header === wanted);
        if (column === undefined) {
            unresolved.push({ role, header: wanted });
            return null;
        }
        return column.index;
    };

    const resolveOptional = (
        role: keyof PersistedColumnRoles,
        header: string | null | undefined,
    ): number | null => {
        if (header === null || header === undefined || header.trim() === "") return null;
        return resolve(role, header);
    };

    // Resolve in role order so `unresolved` reads
    // sendAddress → trackingKey → invoiceGuid → ccAddress → phone.
    const sendAddress = resolveOptional("sendAddress", persisted.sendAddress);
    const trackingKey = resolve("trackingKey", persisted.trackingKey);
    const invoiceGuid = resolveOptional("invoiceGuid", persisted.invoiceGuid);
    const ccAddress = resolveOptional("ccAddress", persisted.ccAddress);
    const phone = resolveOptional("phone", persisted.phone);

    if (unresolved.length > 0 || trackingKey === null) {
        return { status: "unresolved", unresolved };
    }

    return { status: "ok", roles: { sendAddress, trackingKey, invoiceGuid, ccAddress, phone } };
}

/**
 * Materialise recipients from retained columns + a role designation. Identity is
 * the normalised tracking-key value; each recipient carries a variables bag of
 * its full row. Rows with a blank/malformed tracking key, or one shared with any
 * other row, are held (not materialised). See the module doc for the rules.
 */
export function materialiseRecipients(
    uploaded: UploadedColumns,
    roles: ColumnRoles,
): MaterialiseResult {
    const { columns, dataRows } = uploaded;

    // First pass: which normalised tracking keys occur more than once. A repeat
    // means a contact with multiple outstanding invoices — a hard hold, so we
    // must know duplicates before deciding whether the first occurrence sends.
    const keyCounts = new Map<string, number>();
    for (const row of dataRows) {
        const key = normaliseContactId(row[roles.trackingKey] ?? "");
        if (key !== null) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }

    const recipients: MaterialisedRecipient[] = [];
    const held: HeldRow[] = [];

    dataRows.forEach((row, rowIndex) => {
        const rawKey = (row[roles.trackingKey] ?? "").trim();
        const key = normaliseContactId(rawKey);

        if (key === null) {
            held.push({ rowIndex, reason: "missing-tracking-key", trackingKey: rawKey });
            return;
        }
        if ((keyCounts.get(key) ?? 0) > 1) {
            held.push({ rowIndex, reason: "duplicate-tracking-key", trackingKey: key });
            return;
        }

        const variables: Record<string, string> = {};
        for (const column of columns) {
            variables[column.header] = row[column.index] ?? "";
        }

        recipients.push({
            rowIndex,
            recipientId: key,
            sendAddress: cellForRole(row, roles.sendAddress),
            invoiceGuid: cellForRole(row, roles.invoiceGuid),
            phone: cellForRole(row, roles.phone),
            variables,
        });
    });

    return { recipients, held };
}

/** The trimmed cell for an optional role column, or null when unassigned. */
function cellForRole(row: string[], columnIndex: number | null): string | null {
    if (columnIndex === null) return null;
    return (row[columnIndex] ?? "").trim();
}

/**
 * A recipient in the exact shape `campaignQueue.queueCampaignBatches` consumes on
 * its **explicit-recipients** path — identity in `id`, the send address in
 * `email`, and the row's full merge bag JSON-encoded in `variables`. Producing
 * this shape is how an uploaded row reaches the send pipeline **without** a
 * Dynamics re-fetch: the row's own cells travel through as the recipient.
 */
export interface UploadRecipient {
    /** The recipient's identity: the normalised tracking-key value. */
    id: string;
    /**
     * Display name for the send payload's required `name` slot. The bad-debt
     * model has **no name role** — messages render entirely from the `{column}`
     * merge bag — so this is always `""`; it exists only because the send-path
     * payload (and the attempted-row seam) requires a `name` field.
     */
    name: string;
    /** The send-address cell, omitted when no send-address role is designated. */
    email?: string;
    /**
     * The phone cell, omitted when no phone role is designated. This is the
     * WhatsApp send destination the sender's phone lookup + E.164 normalisation
     * resolve against for an uploaded recipient (PRD #84, issue #85).
     */
    phone?: string;
    /**
     * The per-recipient merge bag (`{ header: cell }`) as a JSON string — the
     * `variables` slot the email/WhatsApp adapters parse for `{column}`
     * substitution. Always present (an empty-bag row still serialises to `{}`).
     */
    variables: string;
}

export type PrepareUploadResult =
    | { status: "unresolved"; unresolved: UnresolvedRole[] }
    | {
          status: "ok";
          /**
           * Recipients the send path may send. Tracking-key holds are always
           * excluded; when a {@link ValidationContext} is supplied, content-held
           * rows (missing column, empty referenced cell, invalid address, missing
           * PDF) are excluded too — so the send path refuses every held row.
           */
          recipients: UploadRecipient[];
          /** Rows held out (blank/malformed key, or a duplicated key), for the report. */
          held: HeldRow[];
          /**
           * The full consolidated pre-send report — present only when a
           * {@link ValidationContext} was supplied. Its `held` includes the
           * tracking-key holds *and* the content holds; `sendable` matches
           * `recipients`. This is the single report the operator reads (#67).
           */
          report?: ValidationReport;
      };

/**
 * Optional template + PDF context that turns {@link prepareUploadForSend} from a
 * tracking-key-only gate into the full pre-send validation gate (#67). When
 * supplied, the returned `recipients` are only those cleared by
 * {@link buildValidationReport}, so held rows can never reach the send path.
 */
export interface ValidationContext {
    /** The `{placeholder}` names the template references (subject + body). */
    placeholders: readonly string[];
    /** Per-recipient PDF status, keyed by `recipientId`; absent = passing sentinel. */
    pdfStatus?: Readonly<Record<string, PdfStatus>>;
    /**
     * WhatsApp authoring inputs (PRD #84, issue #87) — present only for a WhatsApp
     * upload. When supplied, the report warns about unmapped template variables and
     * a missing phone column, and holds recipients with a blank/malformed phone. An
     * email upload omits this, so those warnings never fire.
     */
    whatsapp?: {
        /** The template's variables to map (body positions + button variables). */
        fields: readonly TemplateVariableField[];
        /** The operator's current variable→column mapping (logical name → header). */
        mapping: Readonly<Record<string, string>>;
    };
}

/** Project one materialised recipient into the send-path payload shape. */
export function toUploadRecipient(r: MaterialisedRecipient): UploadRecipient {
    const payload: UploadRecipient = {
        id: r.recipientId,
        name: "",
        variables: JSON.stringify(r.variables),
    };
    if (r.sendAddress !== null) payload.email = r.sendAddress;
    if (r.phone !== null) payload.phone = r.phone;
    return payload;
}

/**
 * The AC #5 seam: turn a parsed upload + the campaign's persisted role
 * designation into the recipients the send pipeline consumes — the load-bearing
 * reversal that makes the **uploaded row**, not a Dynamics re-fetch, the source
 * of truth at send time.
 *
 * It composes {@link resolveColumnRoles} (persisted-header → index) and
 * {@link materialiseRecipients} (tracking-key identity + variables bag), then
 * projects each materialised recipient into the {@link UploadRecipient} payload:
 * the tracking key fills `id` (so the one-message-per-`(campaign, recipient)`
 * idempotency seam keeps working unchanged), the send-address cell fills `email`
 * (omitted when unassigned, e.g. a WhatsApp upload), the phone cell fills `phone`
 * (omitted when unassigned, e.g. an email upload) so the WhatsApp sender resolves
 * a destination, and the full row travels as the JSON-encoded `variables` bag.
 *
 * When a designated header is missing from the upload the roles cannot be
 * resolved, so it returns `unresolved` (the caller holds the whole upload rather
 * than materialising against the wrong columns). Otherwise it returns the
 * sendable `recipients` **and** the `held` rows, so the caller can both send and
 * show the pre-send validation report (#67).
 */
export function prepareUploadForSend(
    uploaded: UploadedColumns,
    persisted: PersistedColumnRoles,
    validation?: ValidationContext,
): PrepareUploadResult {
    const resolved = resolveColumnRoles(uploaded.columns, persisted);
    if (resolved.status === "unresolved") {
        return { status: "unresolved", unresolved: resolved.unresolved };
    }

    const materialised = materialiseRecipients(uploaded, resolved.roles);

    // No template context: tracking-key gate only (the #65 behaviour).
    if (!validation) {
        return {
            status: "ok",
            recipients: materialised.recipients.map(toUploadRecipient),
            held: materialised.held,
        };
    }

    // Full pre-send gate: only rows the report clears reach the send path. A
    // WhatsApp upload also carries the authored variable mapping and whether a
    // phone column was designated, so the report can warn on both (#87).
    const report = buildValidationReport(
        validation.placeholders,
        materialised,
        validation.pdfStatus,
        validation.whatsapp
            ? {
                  fields: validation.whatsapp.fields,
                  mapping: validation.whatsapp.mapping,
                  columns: uploaded.columns,
                  phoneDesignated: resolved.roles.phone !== null,
              }
            : undefined,
    );
    return {
        status: "ok",
        recipients: report.sendable.map(toUploadRecipient),
        held: materialised.held,
        report,
    };
}
