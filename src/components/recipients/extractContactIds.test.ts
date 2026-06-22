import { describe, it, expect } from "vitest";
import { extractContactIds, normaliseContactId } from "./extractContactIds";

// Four valid, distinct Dynamics-shaped GUIDs to draw on in the cases below.
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

describe("normaliseContactId", () => {
    const cases: Array<[string, string, string | null]> = [
        ["canonical guid", A, A],
        ["upper-cased guid is lower-cased", A.toUpperCase(), A],
        ["braced guid has braces stripped", `{${A}}`, A],
        ["surrounding whitespace trimmed", `  ${A}  `, A],
        ["blank cell", "", null],
        ["whitespace-only cell", "   ", null],
        ["not a guid", "not-an-id", null],
        ["guid missing a segment", "1111-1111-1111-1111", null],
    ];
    it.each(cases)("%s", (_label, input, expected) => {
        expect(normaliseContactId(input)).toBe(expected);
    });
});

describe("extractContactIds (tier 1: explicit contactid header)", () => {
    it("parses a clean contactid column", () => {
        const result = extractContactIds([
            ["name", "contactid"],
            ["Alice", A],
            ["Bob", B],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 1, header: "contactid" });
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(0);
    });

    it("detects the contactid header case-insensitively and trimmed", () => {
        const result = extractContactIds([
            ["  ContactID  "],
            [A],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 0, header: "ContactID" });
        expect(result.contactIds).toEqual([A]);
    });

    it("collapses duplicate ids to one (case/brace insensitive), not counted as skipped", () => {
        const result = extractContactIds([
            ["contactid"],
            [A],
            [A.toUpperCase()],
            [`{${A}}`],
            [B],
        ]);
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(0);
    });

    it("skips blank and malformed rows, counting them", () => {
        const result = extractContactIds([
            ["contactid"],
            [A],
            [""],
            ["not-a-guid"],
            [B],
        ]);
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(2);
    });

    it("reads the id from the detected column regardless of position", () => {
        const result = extractContactIds([
            ["contactid", "name"],
            [A, "Alice"],
            [B, "Bob"],
        ]);
        expect(result.idColumn?.index).toBe(0);
        expect(result.contactIds).toEqual([A, B]);
    });

    it("returns empty status for a file with no rows at all", () => {
        const result = extractContactIds([]);
        expect(result.status).toBe("empty");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
    });

    it("returns ok with no ids for a headers-only file", () => {
        const result = extractContactIds([["contactid"]]);
        expect(result.status).toBe("ok");
        expect(result.contactIds).toEqual([]);
        expect(result.skippedRows).toBe(0);
    });

    it("returns no-column when no contactid header is present", () => {
        const result = extractContactIds([
            ["name", "email"],
            ["Alice", "alice@example.com"],
        ]);
        expect(result.status).toBe("no-column");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
    });

    it("flags ambiguous when more than one contactid column is present", () => {
        const result = extractContactIds([
            ["contactid", "ContactId"],
            [A, B],
            [C, A],
        ]);
        expect(result.status).toBe("ambiguous");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
        expect(result.candidates.map((c) => c.index)).toEqual([0, 1]);
    });
});
