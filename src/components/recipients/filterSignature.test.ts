import { describe, it, expect } from "vitest";
import { filterSignature } from "./filterSignature";

describe("filterSignature", () => {
    it("is stable across object identity for equal values", () => {
        const a = { search: "joe", clientType: [1, 2], entityType: null };
        const b = { search: "joe", clientType: [1, 2], entityType: null };
        expect(a).not.toBe(b);
        expect(filterSignature(a)).toBe(filterSignature(b));
    });

    it("ignores object key order", () => {
        const a = { search: "joe", province: "WC", ownerId: null };
        const b = { ownerId: null, search: "joe", province: "WC" };
        expect(filterSignature(a)).toBe(filterSignature(b));
    });

    it("changes when a filter value changes", () => {
        const base = { search: "joe", clientType: [1, 2] };
        expect(filterSignature(base)).not.toBe(
            filterSignature({ search: "jane", clientType: [1, 2] }),
        );
        expect(filterSignature(base)).not.toBe(
            filterSignature({ search: "joe", clientType: [1, 3] }),
        );
    });

    it("treats arrays as ordered", () => {
        expect(filterSignature({ sourceCode: [1, 2] })).not.toBe(
            filterSignature({ sourceCode: [2, 1] }),
        );
    });

    it("canonicalises nested objects and the composite reload key", () => {
        const left = filterSignature({
            filters: { search: "x", clientType: [1] },
            audience: "clients",
            leadFilters: { status: "active", province: null },
        });
        const right = filterSignature({
            audience: "clients",
            leadFilters: { province: null, status: "active" },
            filters: { clientType: [1], search: "x" },
        });
        expect(left).toBe(right);
    });

    it("distinguishes audience changes in the composite key", () => {
        const clients = filterSignature({ audience: "clients", filters: { search: "x" } });
        const leads = filterSignature({ audience: "leads", filters: { search: "x" } });
        expect(clients).not.toBe(leads);
    });
});
