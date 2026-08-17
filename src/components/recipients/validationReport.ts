/**
 * Pre-send validation gate — pure core (PRD `prd-bad-debt-excel-campaign.md`, issue #67).
 *
 * This is the safety surface that replaces all conditional-rendering logic. Before
 * any send, the tool produces ONE consolidated report and **holds** (does not send)
 * any row that cannot be rendered completely, so nothing half-filled ever goes out.
 *
 * A row is held when it:
 *   - references a template placeholder with **no matching column** (campaign-level:
 *     the template cannot render for anyone, so every row is held) → `unmatched-placeholder`;
 *   - has an **empty cell** in a referenced column → `empty-referenced-cell`;
 *   - has an **invalid or missing send address** → `invalid-send-address`;
 *   - **shares a tracking key** with another row (a contact with more than one
 *     outstanding invoice — the single-invoice-only hard gate) → `duplicate-tracking-key`;
 *   - has a **blank/malformed tracking key** → `missing-tracking-key`;
 *   - has **no successfully generated PDF** → `missing-pdf`.
 *
 * The tracking-key holds (`missing-`/`duplicate-tracking-key`) are decided upstream by
 * {@link materialiseRecipients}; this gate carries them straight through and layers the
 * content holds on top of the surviving recipients, so `held` is the single list the
 * operator reads and `sendable` is exactly the set the send path is allowed to send.
 *
 * Everything here is pure — no template engine, no Convex, no network — so each hold
 * reason is provable in isolation, exactly as for `extractContactIds`/`sendEligibility`.
 * The `pdfStatus` input is wired now even though PDF pre-generation lands in a later
 * slice: a recipient absent from the map uses the trivially-passing `generated` sentinel,
 * so the gate is complete and testable on its own today.
 */

import type { HeldReason, MaterialiseResult, MaterialisedRecipient } from "./columnRoles";
import type { DetectedColumn } from "./extractContactIds";
import {
    validateVariableMapping,
    type TemplateVariableField,
} from "./whatsappVariableMapping";

/** Per-recipient PDF generation state (drives the `missing-pdf` hold). */
export type PdfStatus = "pending" | "generated" | "failed";

/** Every reason the gate can hold a row for. Extends the tracking-key holds. */
export type ValidationHoldReason =
    | HeldReason // "missing-tracking-key" | "duplicate-tracking-key"
    | "unmatched-placeholder"
    | "empty-referenced-cell"
    | "invalid-send-address"
    | "missing-pdf"
    | "unmapped-variable" // a WhatsApp template variable has no mapped column (campaign-level)
    | "missing-phone"; // no usable phone destination (no column, or a blank/malformed cell)

/** One held row, with every reason it was held (a row can fail several checks). */
export interface ValidationHold {
    /** 0-based index into the upload's data rows (excludes the header). */
    rowIndex: number;
    /** The tracking key: normalised GUID, or the raw cell for a missing/malformed key. */
    trackingKey: string;
    /** All the reasons this row is held, in check order. */
    reasons: ValidationHoldReason[];
}

export interface ValidationReport {
    /**
     * Template placeholders that no uploaded column satisfies (deduped, first-seen
     * order). Campaign-level: while this is non-empty the template cannot render for
     * anyone, so every otherwise-clean row is held with `unmatched-placeholder` and
     * nothing is sendable. Surfaced separately so the operator sees the offending
     * names once rather than repeated on every row.
     */
    unmatchedPlaceholders: string[];
    /**
     * WhatsApp template variables the operator left unmapped (PRD #84, issue #87).
     * Empty for an email upload or a fully-mapped WhatsApp upload. Campaign-level,
     * like {@link unmatchedPlaceholders}: while non-empty the message renders blank
     * variables for everyone, so every recipient is held with `unmapped-variable`.
     * Carries the full field (name + label) so the operator sees *which* to map.
     */
    unmappedVariables: TemplateVariableField[];
    /**
     * True when this is a WhatsApp upload with no phone column designated (PRD #84,
     * issue #87). Campaign-level: with no destination for anyone, every recipient is
     * held with `missing-phone`. Always false for an email upload.
     */
    phoneColumnMissing: boolean;
    /** Every held row (tracking-key holds + content holds), in row order. */
    held: ValidationHold[];
    /** Recipients cleared to send — exactly what the send path may send. */
    sendable: MaterialisedRecipient[];
}

/**
 * The resolved WhatsApp authoring inputs the pre-send report validates (PRD #84,
 * issue #87). Present only for a WhatsApp upload — an email upload passes none, so
 * the variable/phone warnings never fire. Built by {@link prepareUploadForSend}
 * from the selected template's fields, the operator's mapping, the uploaded
 * columns, and whether a phone column role was designated.
 */
export interface WhatsAppReportContext {
    /** The template's variables to map (body positions + button variables). */
    fields: readonly TemplateVariableField[];
    /** The operator's current variable→column mapping (logical name → header). */
    mapping: Readonly<Record<string, string>>;
    /** The uploaded columns, so a mapped-but-absent header still reads as unmapped. */
    columns: readonly DetectedColumn[];
    /** Whether a phone column role has been designated for this upload. */
    phoneDesignated: boolean;
}

/**
 * Built-in merge tokens the email adapter always resolves (layered under the row
 * bag), so a template using them needs no matching column — they must NOT be
 * treated as `unmatched-placeholder`. See `applyMerge` / the email adapter wiring.
 */
export const BUILT_IN_PLACEHOLDERS: ReadonlySet<string> = new Set([
    "firstName",
    "fullName",
    "email",
]);

/** A placeholder is `{` + a non-empty run of non-brace chars + `}` (matches `applyMerge`). */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** A pragmatic send-address check: one `@`, a dot in the domain, no whitespace. */
const SEND_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pull the distinct `{placeholder}` names a template references (subject + body),
 * trimmed and de-duplicated in first-seen order. Built-in tokens
 * ({@link BUILT_IN_PLACEHOLDERS}) are dropped by default, since they need no column
 * to resolve; pass a different `ignore` set to override.
 */
export function extractPlaceholders(
    text: string,
    ignore: ReadonlySet<string> = BUILT_IN_PLACEHOLDERS,
): string[] {
    if (!text) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const match of text.matchAll(PLACEHOLDER)) {
        const name = match[1].trim();
        if (name === "" || ignore.has(name) || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

/** Whether a send address is a plausible, complete email address. */
export function isValidSendAddress(address: string): boolean {
    return SEND_ADDRESS.test(address.trim());
}

/**
 * Whether a raw phone cell is a plausible WhatsApp destination (PRD #84, issue
 * #87). Mirrors the sender's `normalizeToE164Digits` (`convex/lib/whatsapp.ts`):
 * strip non-digits, treat a leading `0` as the SA national prefix (→ `27`), and
 * require 9–15 digits. Kept as a pure local check (not an import of the Convex
 * sender) so this authoring module stays free of network/Convex code — the goal
 * is only to warn the operator, matching what the sender will actually accept.
 */
export function isPlausiblePhone(raw: string | null | undefined): boolean {
    if (!raw) return false;
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("0")) digits = "27" + digits.slice(1);
    return digits.length >= 9 && digits.length <= 15;
}

/**
 * Build the consolidated pre-send validation report from the template's referenced
 * placeholders, the materialised rows, and per-recipient PDF status.
 *
 * `rows` is the output of {@link materialiseRecipients}: its `held` list (tracking-key
 * holds) is carried through unchanged and its `recipients` are each run through the
 * content checks. The available columns are read from the recipients' variables bags
 * (each carries the full row keyed by header), so a placeholder absent from every bag
 * is an `unmatched-placeholder`.
 *
 * `pdfStatus` maps a `recipientId` to its PDF state; a recipient absent from the map
 * uses the trivially-passing `generated` sentinel (PDF pre-gen is a later slice).
 */
export function buildValidationReport(
    placeholders: readonly string[],
    rows: MaterialiseResult,
    pdfStatus: Readonly<Record<string, PdfStatus>> = {},
    whatsapp?: WhatsAppReportContext,
): ValidationReport {
    const { recipients, held: trackingKeyHeld } = rows;

    // Available columns = the union of every recipient's variables-bag keys (each
    // recipient carries the whole row keyed by header). With zero recipients there is
    // nothing sendable regardless, so an empty column set is harmless.
    const columns = new Set<string>();
    for (const r of recipients) {
        for (const header of Object.keys(r.variables)) columns.add(header);
    }

    // Distinct referenced placeholders, split into those a column satisfies (checked
    // per-row for emptiness) and those none does (a campaign-level hold on everyone).
    const wanted = extractDistinct(placeholders);
    const unmatchedPlaceholders = wanted.filter((p) => !columns.has(p));
    const referencedColumns = wanted.filter((p) => columns.has(p));

    // WhatsApp authoring warnings (PRD #84, issue #87) — computed only for a
    // WhatsApp upload (a supplied `whatsapp` context); an email upload leaves both
    // empty/false so nothing new fires. Unmapped variables (validated against the
    // real uploaded columns, so a mapped-but-absent header still counts) and a
    // missing phone column are both campaign-level: while either holds, no row can
    // produce a usable message, so every recipient is held below.
    const unmappedVariables = whatsapp
        ? validateVariableMapping(whatsapp.fields, whatsapp.mapping, whatsapp.columns).unmapped
        : [];
    const phoneColumnMissing = whatsapp ? !whatsapp.phoneDesignated : false;

    // Tracking-key holds carry through as-is, one reason each.
    const held: ValidationHold[] = trackingKeyHeld.map((h) => ({
        rowIndex: h.rowIndex,
        trackingKey: h.trackingKey,
        reasons: [h.reason],
    }));

    const sendable: MaterialisedRecipient[] = [];

    for (const recipient of recipients) {
        const reasons: ValidationHoldReason[] = [];

        // A referenced placeholder has no column → nothing renders for anyone.
        if (unmatchedPlaceholders.length > 0) reasons.push("unmatched-placeholder");

        // A referenced (present) column whose cell is empty for this row.
        const hasEmptyCell = referencedColumns.some(
            (p) => (recipient.variables[p] ?? "").trim() === "",
        );
        if (hasEmptyCell) reasons.push("empty-referenced-cell");

        // Send address: only checked when it is the channel's actual destination.
        //
        // On a WhatsApp upload the destination is the phone, and the send-address
        // role is vestigial — `guessRoles` designates it from any `email` header,
        // so a WhatsApp file that also carries an email column gets one whether or
        // not the addresses mean anything. Checking it there held every row whose
        // client has no email address, i.e. exactly the people WhatsApp is for: in
        // the 2026-08-07 bad-debt run 5, 24 recipients with a valid mobile and a
        // WhatsApp opt-in were silently held on a blank email cell.
        //
        // null = no send-address role at all → nothing to check either way.
        if (!whatsapp && recipient.sendAddress !== null && !isValidSendAddress(recipient.sendAddress)) {
            reasons.push("invalid-send-address");
        }

        // PDF must be successfully generated. Absent from the map = the passing sentinel.
        if ((pdfStatus[recipient.recipientId] ?? "generated") !== "generated") {
            reasons.push("missing-pdf");
        }

        // WhatsApp holds (only when a WhatsApp context is supplied):
        //  - an unmapped variable renders blank for everyone → hold every recipient;
        //  - no usable phone (no column at all, or this row's cell blank/malformed)
        //    means the recipient has no destination → hold this recipient.
        if (whatsapp) {
            if (unmappedVariables.length > 0) reasons.push("unmapped-variable");
            if (!isPlausiblePhone(recipient.phone)) reasons.push("missing-phone");
        }

        if (reasons.length > 0) {
            held.push({ rowIndex: recipient.rowIndex, trackingKey: recipient.recipientId, reasons });
        } else {
            sendable.push(recipient);
        }
    }

    // One report, in row order, so the operator reads holds top-to-bottom.
    held.sort((a, b) => a.rowIndex - b.rowIndex);

    return { unmatchedPlaceholders, unmappedVariables, phoneColumnMissing, held, sendable };
}

/** Trim, drop blanks, de-duplicate in first-seen order. */
function extractDistinct(names: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
        const name = raw.trim();
        if (name === "" || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}
