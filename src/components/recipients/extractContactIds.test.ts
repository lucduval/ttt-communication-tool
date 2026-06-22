import { describe, it, expect } from "vitest";
import { extractContactIds, extractContactIdsForColumn, normaliseContactId } from "./extractContactIds";

// Four valid, distinct Dynamics-shaped GUIDs to draw on in the cases below.
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";
const D = "44444444-4444-4444-4444-444444444444";

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

describe("extractContactIds (tier 2: Dynamics export header)", () => {
    it("detects the (Do Not Modify) <Entity> GUID column from a standard Dynamics export", () => {
        const result = extractContactIds([
            ["(Do Not Modify) Contact", "(Do Not Modify) Row Checksum", "(Do Not Modify) Modified On", "Full Name"],
            [A, "rZ8x==", "6/22/2026 10:00 AM", "Alice"],
            [B, "9kQw==", "6/22/2026 10:05 AM", "Bob"],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 0, header: "(Do Not Modify) Contact" });
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(0);
    });

    it("matches the (Do Not Modify) prefix case-insensitively and trimmed", () => {
        const result = extractContactIds([
            ["  (do not modify) contact  "],
            [A],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 0, header: "(do not modify) contact" });
        expect(result.contactIds).toEqual([A]);
    });

    it("targets the GUID-shaped (Do Not Modify) column, not the checksum sibling, regardless of order", () => {
        const result = extractContactIds([
            ["(Do Not Modify) Row Checksum", "(Do Not Modify) Contact"],
            ["rZ8x==", A],
            ["9kQw==", B],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn?.index).toBe(1);
        expect(result.contactIds).toEqual([A, B]);
    });
});

describe("extractContactIds (tier 3: GUID-shape auto-detect)", () => {
    it("auto-detects a single GUID-shaped column under an arbitrary header", () => {
        const result = extractContactIds([
            ["name", "crm ref", "email"],
            ["Alice", A, "alice@example.com"],
            ["Bob", B, "bob@example.com"],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 1, header: "crm ref" });
        expect(result.contactIds).toEqual([A, B]);
    });

    it("treats a column with GUIDs and blank cells as GUID-shaped, skipping the blanks", () => {
        const result = extractContactIds([
            ["name", "ref"],
            ["Alice", A],
            ["Bob", ""],
            ["Carol", B],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn?.index).toBe(1);
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(1);
    });

    it("does not treat a column mixing GUIDs and non-GUIDs as GUID-shaped", () => {
        const result = extractContactIds([
            ["ref", "name"],
            [A, "Alice"],
            ["not-a-guid", "Bob"],
        ]);
        expect(result.status).toBe("ambiguous");
        expect(result.idColumn).toBeNull();
    });
});

describe("extractContactIds (detection precedence: tier 1 → tier 2 → tier 3)", () => {
    it("prefers the explicit contactid column over a GUID-shaped column elsewhere", () => {
        const result = extractContactIds([
            ["contactid", "legacy ref"],
            [A, B],
            [C, D],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn?.index).toBe(0);
        expect(result.contactIds).toEqual([A, C]);
    });

    it("prefers the Dynamics (Do Not Modify) column over a GUID-shaped column elsewhere", () => {
        const result = extractContactIds([
            ["(Do Not Modify) Contact", "legacy ref"],
            [A, B],
            [C, D],
        ]);
        expect(result.status).toBe("ok");
        expect(result.idColumn?.index).toBe(0);
        expect(result.contactIds).toEqual([A, C]);
    });
});

describe("extractContactIds (ambiguous: needs a manual column choice, never guesses)", () => {
    it("flags ambiguous with the GUID columns as candidates when more than one is GUID-shaped", () => {
        const result = extractContactIds([
            ["primary id", "secondary id", "name"],
            [A, B, "Alice"],
            [C, D, "Bob"],
        ]);
        expect(result.status).toBe("ambiguous");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
        expect(result.candidates.map((c) => c.index)).toEqual([0, 1]);
    });

    it("flags ambiguous with every column as a candidate when no column is GUID-shaped", () => {
        const result = extractContactIds([
            ["name", "email"],
            ["Alice", "alice@example.com"],
        ]);
        expect(result.status).toBe("ambiguous");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
        expect(result.candidates.map((c) => c.index)).toEqual([0, 1]);
    });
});

describe("extractContactIdsForColumn (manual column choice, #54)", () => {
    it("collects ids from the chosen column, ignoring the auto-detection tiers", () => {
        // Two GUID-shaped columns — auto-detect would flag this ambiguous.
        const rows = [
            ["primary id", "secondary id", "name"],
            [A, B, "Alice"],
            [C, D, "Bob"],
        ];
        const result = extractContactIdsForColumn(rows, 1);
        expect(result.status).toBe("ok");
        expect(result.idColumn).toEqual({ index: 1, header: "secondary id" });
        expect(result.contactIds).toEqual([B, D]);
        expect(result.skippedRows).toBe(0);
    });

    it("runs the chosen column through the same dedupe / skip pipeline", () => {
        const rows = [
            ["ref", "name"],
            [A, "Alice"],
            [A.toUpperCase(), "Alice again"], // duplicate — collapsed
            ["", "blank"], // skipped
            ["not-a-guid", "bad"], // skipped
            [B, "Bob"],
        ];
        const result = extractContactIdsForColumn(rows, 0);
        expect(result.status).toBe("ok");
        expect(result.contactIds).toEqual([A, B]);
        expect(result.skippedRows).toBe(2);
    });

    it("trims the chosen column's header for the detected-column label", () => {
        const result = extractContactIdsForColumn([["  Some Column  "], [A]], 0);
        expect(result.idColumn).toEqual({ index: 0, header: "Some Column" });
    });

    it("yields a column with no valid ids when the chosen column holds none", () => {
        const result = extractContactIdsForColumn(
            [
                ["name", "id"],
                ["Alice", A],
            ],
            0, // the name column
        );
        expect(result.status).toBe("ok");
        expect(result.contactIds).toEqual([]);
        expect(result.skippedRows).toBe(1);
    });

    it("returns empty status for a file with no rows", () => {
        const result = extractContactIdsForColumn([], 0);
        expect(result.status).toBe("empty");
        expect(result.idColumn).toBeNull();
        expect(result.contactIds).toEqual([]);
    });
});
