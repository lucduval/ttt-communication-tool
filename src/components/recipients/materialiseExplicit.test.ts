import { describe, it, expect } from "vitest";
import { materialiseExplicit } from "./materialiseExplicit";
import type { SelectableContact } from "@/../convex/lib/recipientSelection";

const contact = (id: string): SelectableContact => ({
    id,
    fullName: `Contact ${id}`,
    email: `${id}@example.com`,
});

describe("materialiseExplicit", () => {
    it("resolves selected ids to full records from a single source", () => {
        const source = [contact("a"), contact("b"), contact("c")];
        const result = materialiseExplicit(new Set(["a", "c"]), source);
        expect(result.map((c) => c.id)).toEqual(["a", "c"]);
        expect(result[0]).toEqual(contact("a"));
    });

    it("Select All across multiple lead pages: ids span pages but only page 1 is in the stale ref", () => {
        // The stale ref only captured page 1; the full set of loaded contacts
        // across pages lives in the on-screen `contacts` source.
        const stalePage1Ref = [contact("a"), contact("b")];
        const loadedContacts = [
            contact("a"),
            contact("b"),
            contact("c"),
            contact("d"),
        ];
        const result = materialiseExplicit(
            new Set(["a", "b", "c", "d"]),
            stalePage1Ref,
            loadedContacts,
        );
        // Every selected id is resolved — none dropped because the ref was short.
        expect(new Set(result.map((c) => c.id))).toEqual(new Set(["a", "b", "c", "d"]));
        expect(result).toHaveLength(4);
    });

    it("manual cross-page selection resolves ids from whichever source holds them", () => {
        const selectionContacts = [contact("x")]; // already in the selection value
        const pageContacts = [contact("y"), contact("z")]; // current on-screen page
        const result = materialiseExplicit(
            new Set(["x", "z"]),
            selectionContacts,
            pageContacts,
        );
        expect(new Set(result.map((c) => c.id))).toEqual(new Set(["x", "z"]));
    });

    it("unchecks after Select All yield the correct smaller set", () => {
        const source = [contact("a"), contact("b"), contact("c"), contact("d")];
        // After unchecking b and d, selectedIds is the smaller set.
        const result = materialiseExplicit(new Set(["a", "c"]), source);
        expect(result.map((c) => c.id)).toEqual(["a", "c"]);
    });

    it("client-side filter mode: full set is in one source (no regression)", () => {
        const allFiltered = [contact("a"), contact("b"), contact("c")];
        const onScreenPage = [contact("a")]; // only the first page is rendered
        const result = materialiseExplicit(
            new Set(["a", "b", "c"]),
            allFiltered,
            onScreenPage,
        );
        expect(new Set(result.map((c) => c.id))).toEqual(new Set(["a", "b", "c"]));
        expect(result).toHaveLength(3);
    });

    it("produces no duplicate records when an id is present in several sources", () => {
        const sourceA = [contact("a"), contact("b")];
        const sourceB = [contact("b"), contact("c")];
        const result = materialiseExplicit(new Set(["a", "b", "c"]), sourceA, sourceB);
        expect(result).toHaveLength(3);
        expect(result.filter((c) => c.id === "b")).toHaveLength(1);
    });

    it("prioritises earlier sources when the same id appears in more than one", () => {
        const priority: SelectableContact = { id: "a", fullName: "Authoritative" };
        const fallback: SelectableContact = { id: "a", fullName: "Stale" };
        const result = materialiseExplicit(new Set(["a"]), [priority], [fallback]);
        expect(result[0].fullName).toBe("Authoritative");
    });

    it("omits ids that cannot be resolved from any source (no phantom recipients)", () => {
        const source = [contact("a")];
        const result = materialiseExplicit(new Set(["a", "ghost"]), source);
        expect(result.map((c) => c.id)).toEqual(["a"]);
    });

    it("returns an empty array when nothing is selected", () => {
        const source = [contact("a"), contact("b")];
        expect(materialiseExplicit(new Set(), source)).toEqual([]);
    });

    it("ignores ids in the sources that are not selected", () => {
        const source = [contact("a"), contact("b"), contact("c")];
        const result = materialiseExplicit(new Set(["b"]), source);
        expect(result.map((c) => c.id)).toEqual(["b"]);
    });
});
