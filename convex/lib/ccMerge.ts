/**
 * CC-merge rule for uploaded-file (source-of-truth) email campaigns
 * (PRD #78, slice #80).
 *
 * A single pure function owns the rule for combining the static campaign-level
 * CC with a recipient's per-row consultant cell, so both email send paths (the
 * batch adapter and the personalised adapter) share one implementation and
 * cannot diverge.
 *
 * Given the static campaign CC (optional) and the recipient's consultant-column
 * cell (optional), it returns the merged CC recipient list, or `undefined` when
 * neither is present. It:
 *   - trims and normalises inputs,
 *   - treats a blank cell (empty or whitespace-only) as absent,
 *   - de-duplicates so an address common to both is CC'd only once — including
 *     partial overlap across comma/semicolon-separated multi-address strings.
 *
 * De-duplication is case- and whitespace-insensitive; the first-seen spelling
 * of each address is preserved in first-seen order. Producing one `{ email }`
 * object per unique address is compatible with the Graph payload builder, which
 * still splits any comma/semicolon-joined `email` value into individual
 * recipients (a no-op on the single addresses returned here).
 */

/** Split a raw CC value into individual, trimmed, non-empty addresses. */
function splitAddresses(value: string | undefined | null): string[] {
    if (!value) return [];
    return value
        .split(/[,;]/)
        .map((addr) => addr.trim())
        .filter((addr) => addr.length > 0);
}

/**
 * Merge the static campaign CC with a recipient's consultant-column cell into a
 * de-duplicated CC recipient list, or `undefined` when neither yields an
 * address.
 */
export function mergeCcRecipients(
    staticCc: string | undefined | null,
    consultantCell: string | undefined | null
): Array<{ email: string }> | undefined {
    const seen = new Set<string>();
    const recipients: Array<{ email: string }> = [];

    for (const address of [...splitAddresses(staticCc), ...splitAddresses(consultantCell)]) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push({ email: address });
    }

    return recipients.length > 0 ? recipients : undefined;
}
