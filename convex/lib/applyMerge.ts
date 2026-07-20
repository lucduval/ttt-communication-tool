/**
 * Flat merge engine for Excel-driven campaigns (PRD bad-debt-excel-campaign, #66).
 *
 * `applyMerge(text, rowContext)` performs FLAT substitution only: every
 * `{column_name}` placeholder is replaced by that row's cell value from
 * `rowContext`. There is deliberately no formatting, no conditionals, and no
 * drop-empty logic — all formatting (amounts as `R#,##0.00`, dates as
 * `d MMMM yyyy`) and all conditional content (pay-now link vs EFT block) is
 * pre-rendered into columns in the export by whoever builds it. The engine only
 * fills blanks.
 *
 * Unresolved-placeholder contract: a `{placeholder}` with no matching key in
 * `rowContext` renders as an EMPTY STRING — never the literal `{placeholder}`.
 * A recipient must never see a raw `{amount}`. The pre-send validation gate
 * (#67) is what actually holds such a row upstream; this engine only guarantees
 * that if one slips through, nothing raw ever leaks.
 */

/** A placeholder is `{` + a non-empty run of non-brace chars + `}`. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

export function applyMerge(text: string, rowContext: Record<string, string>): string {
    if (!text) return text;
    return text.replace(PLACEHOLDER, (_match, rawName: string) => {
        const key = rawName.trim();
        // Present (even if empty) → substitute; absent → empty string (never raw).
        return rowContext[key] ?? "";
    });
}
