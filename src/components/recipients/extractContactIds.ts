/**
 * Contact-id extraction — pure core (PRD #48, issue #50).
 *
 * Turns already-parsed spreadsheet rows into the set of Dynamics contact ids a
 * campaign should target. The first row is the header; this slice implements
 * **tier-1 detection only** — an explicit `contactid` column header
 * (case-insensitive, trimmed). Smarter detection (Dynamics export headers,
 * GUID-shape sniffing, manual column choice) lands in later slices (#52, #54),
 * which is why the result carries an `ambiguous` signal that this slice only
 * ever raises for the one genuinely undecidable tier-1 case: two `contactid`
 * columns.
 *
 * Everything here is pure — no File, no FileReader — so the decision logic is
 * the test surface. A thin impure reader (`readContactIdsFromFile`) feeds rows
 * in. Ids are validated as GUIDs, normalised (braces stripped, lower-cased) and
 * de-duplicated in first-seen order; blank and malformed data rows are counted
 * as skipped rather than silently dropped. Duplicates are collapsed, not
 * skipped — they are valid ids, just repeated.
 */

export type ContactIdExtractionStatus =
    | "ok" // a single contactid column was found (contactIds may still be empty)
    | "empty" // the file had no rows at all
    | "no-column" // no contactid column in the header (tier 1)
    | "ambiguous"; // more than one contactid column — needs a manual choice (#54)

export interface DetectedColumn {
    index: number;
    header: string;
}

export interface ContactIdExtraction {
    status: ContactIdExtractionStatus;
    /** The detected id column, or null when none was found or it was ambiguous. */
    idColumn: DetectedColumn | null;
    /** Validated, normalised, de-duplicated contact ids in first-seen order. */
    contactIds: string[];
    /** Data rows skipped because their id cell was blank or not a GUID. */
    skippedRows: number;
    /** Every contactid column found — populated when status is "ambiguous". */
    candidates: DetectedColumn[];
}

const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

/** Normalise a candidate id cell to a canonical GUID, or null if it isn't one. */
export function normaliseContactId(cell: string): string | null {
    const trimmed = cell.trim();
    if (!GUID.test(trimmed)) return null;
    return trimmed.replace(/[{}]/g, "").toLowerCase();
}

/**
 * Extract contact ids from parsed rows (first row = header). See module doc for
 * the tier-1 detection contract and the meaning of each status.
 */
export function extractContactIds(rows: string[][]): ContactIdExtraction {
    if (rows.length === 0) {
        return { status: "empty", idColumn: null, contactIds: [], skippedRows: 0, candidates: [] };
    }

    const [header, ...dataRows] = rows;
    const candidates = header
        .map((cell, index): DetectedColumn => ({ index, header: cell.trim() }))
        .filter((c) => c.header.toLowerCase() === "contactid");

    if (candidates.length === 0) {
        return { status: "no-column", idColumn: null, contactIds: [], skippedRows: 0, candidates: [] };
    }
    if (candidates.length > 1) {
        return { status: "ambiguous", idColumn: null, contactIds: [], skippedRows: 0, candidates };
    }

    const idColumn = candidates[0];
    const seen = new Set<string>();
    const contactIds: string[] = [];
    let skippedRows = 0;

    for (const row of dataRows) {
        const id = normaliseContactId(row[idColumn.index] ?? "");
        if (id === null) {
            skippedRows++;
            continue;
        }
        if (seen.has(id)) continue; // duplicate — collapse, not a skip
        seen.add(id);
        contactIds.push(id);
    }

    return { status: "ok", idColumn, contactIds, skippedRows, candidates };
}
