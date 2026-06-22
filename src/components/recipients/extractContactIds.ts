/**
 * Contact-id extraction — pure core (PRD #48, issues #50, #52).
 *
 * Turns already-parsed spreadsheet rows into the set of Dynamics contact ids a
 * campaign should target. The first row is the header; the id column is chosen
 * by the first matching tier, in order:
 *
 *   - **Tier 1** — an explicit `contactid` header (case-insensitive, trimmed).
 *   - **Tier 2** — the hidden `(Do Not Modify) <Entity>` GUID column standard
 *     Dynamics exports carry. A Dynamics export also ships sibling
 *     `(Do Not Modify) Row Checksum` / `Modified On` columns, so the match is
 *     narrowed to the `(Do Not Modify)`-prefixed column whose data is
 *     GUID-shaped — never the checksum or timestamp.
 *   - **Tier 3** — GUID-shape auto-detect: when exactly one column's data is
 *     GUID-shaped (under any header), use it.
 *
 * When no tier resolves to a single column the result carries the `ambiguous`
 * signal with `candidates` populated, for the manual column choice in #54 — we
 * never guess. That covers two `contactid` columns (tier 1), zero GUID-shaped
 * columns (candidates = every column), and more than one GUID-shaped column
 * (candidates = the GUID-shaped columns).
 *
 * Everything here is pure — no File, no FileReader — so the decision logic is
 * the test surface. A thin impure reader (`readContactIdsFromFile`) feeds rows
 * in. Ids are validated as GUIDs, normalised (braces stripped, lower-cased) and
 * de-duplicated in first-seen order; blank and malformed data rows are counted
 * as skipped rather than silently dropped. Duplicates are collapsed, not
 * skipped — they are valid ids, just repeated.
 */

export type ContactIdExtractionStatus =
    | "ok" // a single id column was resolved (contactIds may still be empty)
    | "empty" // the file had no rows at all
    | "ambiguous"; // no single id column could be resolved — needs a manual choice (#54)

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

/** A `(Do Not Modify) …` Dynamics export header (case-insensitive, trimmed). */
const DO_NOT_MODIFY = /^\(do not modify\)/i;

/** Normalise a candidate id cell to a canonical GUID, or null if it isn't one. */
export function normaliseContactId(cell: string): string | null {
    const trimmed = cell.trim();
    if (!GUID.test(trimmed)) return null;
    return trimmed.replace(/[{}]/g, "").toLowerCase();
}

/**
 * Is this column's data GUID-shaped? True when it has at least one non-blank
 * data cell and every non-blank cell normalises to a GUID. Blank cells are
 * ignored (they are skipped at extraction time); a single non-GUID cell
 * disqualifies the column so auto-detect never picks a column it can't trust.
 */
function isGuidColumn(dataRows: string[][], index: number): boolean {
    let sawValue = false;
    for (const row of dataRows) {
        const cell = (row[index] ?? "").trim();
        if (cell === "") continue;
        if (normaliseContactId(cell) === null) return false;
        sawValue = true;
    }
    return sawValue;
}

/**
 * Extract contact ids from parsed rows (first row = header). See the module doc
 * for the tier 1 → 2 → 3 detection contract and the meaning of each status.
 */
export function extractContactIds(rows: string[][]): ContactIdExtraction {
    if (rows.length === 0) {
        return { status: "empty", idColumn: null, contactIds: [], skippedRows: 0, candidates: [] };
    }

    const [header, ...dataRows] = rows;
    const columns = header.map((cell, index): DetectedColumn => ({ index, header: cell.trim() }));

    // Tier 1 — explicit contactid header.
    const tier1 = columns.filter((c) => c.header.toLowerCase() === "contactid");
    if (tier1.length === 1) return collect(tier1[0], dataRows);
    if (tier1.length > 1) return ambiguous(tier1);

    // Tier 2 — the Dynamics (Do Not Modify) <Entity> GUID column (not the
    // sibling Row Checksum / Modified On columns: narrow to the GUID-shaped one).
    const dynamicsGuid = columns.filter(
        (c) => DO_NOT_MODIFY.test(c.header) && isGuidColumn(dataRows, c.index),
    );
    if (dynamicsGuid.length === 1) return collect(dynamicsGuid[0], dataRows);

    // Tier 3 — GUID-shape auto-detect across all columns.
    const guidColumns = columns.filter((c) => isGuidColumn(dataRows, c.index));
    if (guidColumns.length === 1) return collect(guidColumns[0], dataRows);

    // Zero or more than one GUID-shaped column — offer a manual choice (#54).
    // Candidates are the GUID-shaped columns when any exist, else every column.
    return ambiguous(guidColumns.length > 0 ? guidColumns : columns);
}

/**
 * Extract contact ids from an explicitly-chosen id column — the manual fallback
 * (#54) for `ambiguous` files. Bypasses the tier 1 → 2 → 3 detection and runs
 * the chosen column straight through the same {@link collect} loop, so a
 * hand-picked column validates, dedupes and skip-counts identically to a
 * detected one. An empty file still yields `empty`.
 */
export function extractContactIdsForColumn(
    rows: string[][],
    columnIndex: number,
): ContactIdExtraction {
    if (rows.length === 0) {
        return { status: "empty", idColumn: null, contactIds: [], skippedRows: 0, candidates: [] };
    }
    const [header, ...dataRows] = rows;
    const idColumn: DetectedColumn = { index: columnIndex, header: (header[columnIndex] ?? "").trim() };
    return collect(idColumn, dataRows);
}

function ambiguous(candidates: DetectedColumn[]): ContactIdExtraction {
    return { status: "ambiguous", idColumn: null, contactIds: [], skippedRows: 0, candidates };
}

/** Run the dedup/skip loop over a chosen id column. */
function collect(idColumn: DetectedColumn, dataRows: string[][]): ContactIdExtraction {
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

    return { status: "ok", idColumn, contactIds, skippedRows, candidates: [idColumn] };
}
