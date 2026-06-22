import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
    parseCsv,
    parseXlsx,
    readContactIdsFromFile,
    extractContactIdsForColumnFromFile,
} from "./readContactIds";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

/** A minimal File stub backed by a string, enough for `.text()`. */
function csvFile(text: string, name = "list.csv"): File {
    return new File([text], name, { type: "text/csv" });
}

/** Build a real .xlsx byte stream from a 2-D array, for parseXlsx tests. */
function xlsxBytes(rows: (string | number)[][], sheets?: Record<string, (string | number)[][]>): Uint8Array {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
    for (const [name, data] of Object.entries(sheets ?? {})) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name);
    }
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

describe("parseCsv", () => {
    it("parses a simple comma-separated grid", () => {
        expect(parseCsv("name,contactid\nAlice,1\nBob,2")).toEqual([
            ["name", "contactid"],
            ["Alice", "1"],
            ["Bob", "2"],
        ]);
    });

    it("handles CRLF line endings", () => {
        expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    it("strips a leading UTF-8 BOM from the first cell", () => {
        expect(parseCsv("﻿contactid\n1")).toEqual([["contactid"], ["1"]]);
    });

    it("respects quoted fields containing commas and quotes", () => {
        expect(parseCsv('name,note\n"Smith, Jane","said ""hi"""')).toEqual([
            ["name", "note"],
            ["Smith, Jane", 'said "hi"'],
        ]);
    });

    it("keeps embedded newlines inside quoted fields", () => {
        expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
    });

    it("drops fully-blank lines (e.g. a trailing newline)", () => {
        expect(parseCsv("a\n1\n\n")).toEqual([["a"], ["1"]]);
    });

    it("returns no rows for empty text", () => {
        expect(parseCsv("")).toEqual([]);
    });
});

describe("parseXlsx", () => {
    it("parses a workbook's first sheet into a string grid", () => {
        const bytes = xlsxBytes([
            ["name", "contactid"],
            ["Alice", "00000000-0000-0000-0000-000000000001"],
            ["Bob", "00000000-0000-0000-0000-000000000002"],
        ]);
        expect(parseXlsx(bytes)).toEqual([
            ["name", "contactid"],
            ["Alice", "00000000-0000-0000-0000-000000000001"],
            ["Bob", "00000000-0000-0000-0000-000000000002"],
        ]);
    });

    it("coerces non-string cells (numbers) to text so downstream sees strings", () => {
        expect(parseXlsx(xlsxBytes([["id", "count"], ["x", 42]]))).toEqual([
            ["id", "count"],
            ["x", "42"],
        ]);
    });

    it("pads short rows with empty cells (defval) rather than dropping columns", () => {
        // aoa_to_sheet keeps a sparse last column; defval:"" fills the gap.
        const bytes = xlsxBytes([
            ["a", "contactid"],
            ["only-first"],
        ]);
        expect(parseXlsx(bytes)).toEqual([
            ["a", "contactid"],
            ["only-first", ""],
        ]);
    });

    it("drops fully-blank rows, mirroring the CSV reader", () => {
        const bytes = xlsxBytes([
            ["contactid"],
            ["00000000-0000-0000-0000-000000000001"],
            [""],
            ["00000000-0000-0000-0000-000000000002"],
        ]);
        expect(parseXlsx(bytes)).toEqual([
            ["contactid"],
            ["00000000-0000-0000-0000-000000000001"],
            ["00000000-0000-0000-0000-000000000002"],
        ]);
    });

    it("reads only the first sheet", () => {
        const bytes = xlsxBytes(
            [["contactid"], ["00000000-0000-0000-0000-000000000001"]],
            { Other: [["contactid"], ["00000000-0000-0000-0000-000000000099"]] },
        );
        expect(parseXlsx(bytes)).toEqual([
            ["contactid"],
            ["00000000-0000-0000-0000-000000000001"],
        ]);
    });

    it("accepts an ArrayBuffer as well as a Uint8Array", () => {
        const bytes = xlsxBytes([["contactid"], ["00000000-0000-0000-0000-000000000001"]]);
        const buffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        expect(parseXlsx(buffer)).toEqual(parseXlsx(bytes));
    });

    it("returns no rows for a blank sheet", () => {
        expect(parseXlsx(xlsxBytes([[""]]))).toEqual([]);
    });
});

describe("extractContactIdsForColumnFromFile (manual column choice, #54)", () => {
    it("re-reads the file and collects ids from the chosen column", async () => {
        // Two GUID columns: auto-detect is ambiguous, the manual choice resolves it.
        const file = csvFile(`primary,secondary,name\n${A},${B},Alice\n${B},${A},Bob`);
        const auto = await readContactIdsFromFile(file);
        expect(auto.status).toBe("ambiguous");
        expect(auto.candidates.map((c) => c.index)).toEqual([0, 1]);

        const chosen = await extractContactIdsForColumnFromFile(file, 1);
        expect(chosen.status).toBe("ok");
        expect(chosen.idColumn).toEqual({ index: 1, header: "secondary" });
        expect(chosen.contactIds).toEqual([B, A]);
    });

    it("produces the same dedupe / skip summary as auto-detection on the chosen column", async () => {
        const file = csvFile(`ref,name\n${A},Alice\n${A},dup\n,blank\n${B},Bob`);
        const chosen = await extractContactIdsForColumnFromFile(file, 0);
        expect(chosen.contactIds).toEqual([A, B]);
        expect(chosen.skippedRows).toBe(1);
    });
});
