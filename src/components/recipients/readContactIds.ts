import { extractContactIds, type ContactIdExtraction } from "./extractContactIds";

/**
 * CSV reader wrapper (PRD #48, issue #50) — the thin impure seam between a
 * dropped file and the pure {@link extractContactIds} decision logic.
 *
 * `parseCsv` is itself pure (text → rows) and unit-tested; the only impurity
 * lives in `readContactIdsFromFile`, which reads the File's text. The file is
 * purely a source of contact ids — never structured recipient data — so the
 * parser only needs to be good enough to recover cells: it handles quoted
 * fields (embedded commas, escaped `""` quotes, embedded newlines), CRLF or LF
 * endings, and a leading UTF-8 BOM.
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
 * Read a dropped CSV file and extract its contact ids. Impure (reads the File);
 * all decisions live in the pure core it delegates to.
 */
export async function readContactIdsFromFile(file: File): Promise<ContactIdExtraction> {
    const text = await file.text();
    return extractContactIds(parseCsv(text));
}
