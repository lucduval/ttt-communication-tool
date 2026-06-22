import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseCsv, parseXlsx } from "./readContactIds";

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
