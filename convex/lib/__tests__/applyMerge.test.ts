/**
 * Pure merge-engine tests (PRD bad-debt-excel-campaign, #66).
 *
 * `applyMerge` is flat substitution only: `{column}` → that row's cell value,
 * no formatting, no branching, no drop-empty logic. The load-bearing contract
 * asserted here is that an unresolved placeholder NEVER leaks a raw `{token}`
 * to a recipient. Prior art: the current inline `applyMergeFields` behaviour.
 */
import { describe, it, expect } from "vitest";
import { applyMerge } from "../applyMerge";

describe("applyMerge", () => {
    it("substitutes a single {column} with the row's cell value", () => {
        expect(applyMerge("Hi {firstName}", { firstName: "Alice" })).toBe("Hi Alice");
    });

    it("substitutes every occurrence of a repeated placeholder", () => {
        expect(applyMerge("{name} & {name}", { name: "Bo" })).toBe("Bo & Bo");
    });

    it("substitutes multiple distinct placeholders in one pass", () => {
        const ctx = { amount: "R1,200.00", invoiceNumber: "INV-42" };
        expect(applyMerge("You owe {amount} on {invoiceNumber}.", ctx)).toBe(
            "You owe R1,200.00 on INV-42."
        );
    });

    it("is flat only — does no formatting, keeps the cell value verbatim", () => {
        // Whatever is in the cell is exactly what the recipient sees.
        expect(applyMerge("{amount}", { amount: "1200" })).toBe("1200");
        expect(applyMerge("{when}", { when: "5 July 2026" })).toBe("5 July 2026");
    });

    it("never emits a raw {placeholder} for an unresolved column — renders empty", () => {
        // The validation gate (#67) holds such a row upstream; the engine's own
        // contract is that if one slips through, nothing raw ever leaks.
        expect(applyMerge("Owe {amount}", {})).toBe("Owe ");
        expect(applyMerge("{a}-{b}", { a: "X" })).toBe("X-");
    });

    it("renders a present-but-empty cell as empty (no drop-empty logic)", () => {
        expect(applyMerge("[{amount}]", { amount: "" })).toBe("[]");
    });

    it("trims whitespace inside the braces before matching the column header", () => {
        expect(applyMerge("{ amount }", { amount: "R5" })).toBe("R5");
    });

    it("leaves a text with no placeholders untouched", () => {
        expect(applyMerge("plain text, no merge", { a: "1" })).toBe("plain text, no merge");
    });

    it("returns falsy input unchanged", () => {
        expect(applyMerge("", { a: "1" })).toBe("");
    });
});
