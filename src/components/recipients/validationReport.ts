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

/** Per-recipient PDF generation state (drives the `missing-pdf` hold). */
export type PdfStatus = "pending" | "generated" | "failed";

/** Every reason the gate can hold a row for. Extends the tracking-key holds. */
export type ValidationHoldReason =
    | HeldReason // "missing-tracking-key" | "duplicate-tracking-key"
    | "unmatched-placeholder"
    | "empty-referenced-cell"
    | "invalid-send-address"
    | "missing-pdf";

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
    /** Every held row (tracking-key holds + content holds), in row order. */
    held: ValidationHold[];
    /** Recipients cleared to send — exactly what the send path may send. */
    sendable: MaterialisedRecipient[];
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

        // Send address: null = no send-address role (e.g. a WhatsApp upload) → skip;
        // otherwise it must be a complete, valid address.
        if (recipient.sendAddress !== null && !isValidSendAddress(recipient.sendAddress)) {
            reasons.push("invalid-send-address");
        }

        // PDF must be successfully generated. Absent from the map = the passing sentinel.
        if ((pdfStatus[recipient.recipientId] ?? "generated") !== "generated") {
            reasons.push("missing-pdf");
        }

        if (reasons.length > 0) {
            held.push({ rowIndex: recipient.rowIndex, trackingKey: recipient.recipientId, reasons });
        } else {
            sendable.push(recipient);
        }
    }

    // One report, in row order, so the operator reads holds top-to-bottom.
    held.sort((a, b) => a.rowIndex - b.rowIndex);

    return { unmatchedPlaceholders, held, sendable };
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
