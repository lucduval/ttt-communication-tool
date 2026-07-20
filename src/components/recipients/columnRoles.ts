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
 */
export interface ColumnRoles {
    sendAddress: number | null;
    trackingKey: number;
    invoiceGuid: number | null;
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
 * role in `sendAddress, trackingKey, invoiceGuid` order, so the caller can hold
 * the upload rather than materialise against the wrong columns.
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

    // Resolve in role order so `unresolved` reads sendAddress → trackingKey → invoiceGuid.
    const sendAddress = resolveOptional("sendAddress", persisted.sendAddress);
    const trackingKey = resolve("trackingKey", persisted.trackingKey);
    const invoiceGuid = resolveOptional("invoiceGuid", persisted.invoiceGuid);

    if (unresolved.length > 0 || trackingKey === null) {
        return { status: "unresolved", unresolved };
    }

    return { status: "ok", roles: { sendAddress, trackingKey, invoiceGuid } };
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
            recipientId: key,
            sendAddress: cellForRole(row, roles.sendAddress),
            invoiceGuid: cellForRole(row, roles.invoiceGuid),
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
