import * as XLSX from "xlsx";
import {
    extractContactIds,
    extractContactIdsForColumn,
    type ContactIdExtraction,
} from "./extractContactIds";
import { parseUploadedColumns, type UploadedColumns } from "./columnRoles";

/**
 * File readers (PRD #48, issues #50 + #51) — the thin impure seam between a
 * dropped file and the pure {@link extractContactIds} decision logic.
 *
 * `parseCsv` and `parseXlsx` are both pure (bytes/text → rows) and unit-tested;
 * the only impurity lives in `readContactIdsFromFile`, which reads the File's
 * bytes. The file is purely a source of contact ids — never structured
 * recipient data — so the parsers only need to be good enough to recover cells.
 * `parseCsv` handles quoted fields (embedded commas, escaped `""` quotes,
 * embedded newlines), CRLF or LF endings, and a leading UTF-8 BOM; `parseXlsx`
 * (#51) lets a Dynamics "Export to Excel" workbook feed the same pipeline
 * without the user round-tripping it through CSV first.
 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    let start = 0;
    if (text.charCodeAt(0) === 0xfeff) start = 1; // strip BOM

    const pushField = () => {
        row.push(field);
        field = "";
    };
    const pushRow = () => {
        pushField();
        rows.push(row);
        row = [];
    };

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            pushField();
        } else if (ch === "\n") {
            pushRow();
        } else if (ch !== "\r") {
            field += ch;
        }
    }
    if (field.length > 0 || row.length > 0) pushRow();

    // Drop fully-blank lines (a trailing newline yields one) so they aren't
    // mistaken for skipped data rows downstream.
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Parse an `.xlsx` workbook's first sheet into the same `string[][]` grid
 * `parseCsv` produces. Pure (deterministic bytes → rows): the impure
 * `ArrayBuffer` read stays in {@link readContactIdsFromFile}. `raw: false`
 * formats every cell as text (so numeric/date cells arrive as strings),
 * `defval: ""` pads short rows, and fully-blank rows are dropped to match the
 * CSV reader so downstream skip-counting is identical across formats.
 */
export function parseXlsx(data: ArrayBuffer | Uint8Array): string[][] {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const workbook = XLSX.read(bytes, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return [];

    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[firstSheet], {
        header: 1,
        raw: false,
        defval: "",
    });
    return rows
        .map((row) => row.map((cell) => String(cell)))
        .filter((row) => row.some((cell) => cell.trim() !== ""));
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isXlsx(file: File): boolean {
    return /\.xlsx$/i.test(file.name) || file.type === XLSX_MIME;
}

/** Read a dropped file's bytes into the shared `string[][]` grid. The only
 * impurity — both reader entry points below delegate to it, so CSV/XLSX format
 * detection lives in one place and the chosen-column re-read (#54) parses the
 * file exactly as the auto-detect pass did (same indices). */
async function readRows(file: File): Promise<string[][]> {
    return isXlsx(file) ? parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
}

/**
 * Read a dropped CSV or XLSX file and extract its contact ids. Impure (reads
 * the File); all decisions live in the pure core it delegates to. The format is
 * chosen by extension/MIME, then both paths converge on {@link extractContactIds}.
 */
export async function readContactIdsFromFile(file: File): Promise<ContactIdExtraction> {
    return extractContactIds(await readRows(file));
}

/**
 * Re-read a file and extract its ids from an explicitly-chosen column — the
 * manual fallback (#54) when auto-detection was `ambiguous`. Re-parses the same
 * bytes (deterministic, so the chosen index still lines up) and runs the column
 * through {@link extractContactIdsForColumn}, yielding the same `ok` result
 * shape an auto-detected file produces.
 */
export async function extractContactIdsForColumnFromFile(
    file: File,
    columnIndex: number,
): Promise<ContactIdExtraction> {
    return extractContactIdsForColumn(await readRows(file), columnIndex);
}

/**
 * Read a dropped CSV or XLSX file and retain **every** column (PRD
 * `prd-bad-debt-excel-campaign.md`, issue #65) — the source-of-truth path where
 * the file drives message content, not just targeting. Impure (reads the File);
 * reuses the exact same {@link readRows} seam as the contact-id path, so a file
 * parses identically whichever path consumes it. All decisions live in the pure
 * {@link parseUploadedColumns} core it delegates to.
 */
export async function readUploadedColumnsFromFile(file: File): Promise<UploadedColumns> {
    return parseUploadedColumns(await readRows(file));
}
