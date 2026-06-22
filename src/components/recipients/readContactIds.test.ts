import { describe, it, expect } from "vitest";
import { parseCsv } from "./readContactIds";

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
