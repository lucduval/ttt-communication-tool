import type { SelectableContact } from "@/../convex/lib/recipientSelection";

/**
 * Materialise an explicit recipient selection from a gesture and the contact
 * records available at navigation time (PRD #36, issue #37).
 *
 * Given `selectedIds` — the raw "which ids are checked" gesture — and one or
 * more record `sources` (in priority order: the contacts already in the
 * selection value, the loaded on-screen `contacts` array, the first-page
 * `allFilteredContactsRef`), it returns the full contact record for every
 * selected id, resolving each id from a **prioritised union** of all sources.
 *
 * This is the seam that stops the navigation path from collapsing a complete
 * selection down to whatever happened to be loaded on screen: an id present in
 * *any* source is never dropped because an earlier source was short. The result
 * contains exactly the resolvable ids in `selectedIds`, with no duplicate or
 * phantom records — unresolvable ids are simply absent.
 *
 * When an id appears in more than one source, the earliest source wins (its
 * record is authoritative). Records are returned in the order they are first
 * encountered while walking the sources in priority order.
 */
export function materialiseExplicit(
    selectedIds: Set<string>,
    ...sources: SelectableContact[][]
): SelectableContact[] {
    const resolved: SelectableContact[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
        for (const contact of source) {
            if (seen.has(contact.id)) continue;
            if (!selectedIds.has(contact.id)) continue;
            seen.add(contact.id);
            resolved.push(contact);
        }
    }

    return resolved;
}
