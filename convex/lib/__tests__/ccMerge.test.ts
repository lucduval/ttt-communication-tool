import { describe, test, expect } from "vitest";
import { consultantCellFromBag, mergeCcRecipients } from "../ccMerge";

describe("consultantCellFromBag", () => {
    const bag = JSON.stringify({ Email: "pat@x.co", Consultant: "cons@firm.co", Blank: "" });

    test("reads the designated header's cell", () => {
        expect(consultantCellFromBag(bag, "Consultant")).toBe("cons@firm.co");
    });

    test("trims the header and the bag keys before matching", () => {
        const spaced = JSON.stringify({ "  Consultant  ": "cons@firm.co" });
        expect(consultantCellFromBag(spaced, "Consultant")).toBe("cons@firm.co");
        expect(consultantCellFromBag(bag, "  Consultant  ")).toBe("cons@firm.co");
    });

    test("no header designated → undefined (static-only behaviour)", () => {
        expect(consultantCellFromBag(bag, undefined)).toBeUndefined();
        expect(consultantCellFromBag(bag, "   ")).toBeUndefined();
    });

    test("absent or malformed bag → undefined", () => {
        expect(consultantCellFromBag(undefined, "Consultant")).toBeUndefined();
        expect(consultantCellFromBag("not json", "Consultant")).toBeUndefined();
        expect(consultantCellFromBag("null", "Consultant")).toBeUndefined();
    });

    test("designated header absent from the bag → undefined", () => {
        expect(consultantCellFromBag(bag, "Missing")).toBeUndefined();
    });

    test("blank cell is returned verbatim (mergeCcRecipients treats it as absent)", () => {
        expect(consultantCellFromBag(bag, "Blank")).toBe("");
    });
});

describe("mergeCcRecipients", () => {
    test("static CC only, no consultant cell → returns the static CC", () => {
        expect(mergeCcRecipients("audit@firm.co", undefined)).toEqual([
            { email: "audit@firm.co" },
        ]);
    });

    test("consultant cell only, no static CC → returns the consultant CC", () => {
        expect(mergeCcRecipients(undefined, "consultant@firm.co")).toEqual([
            { email: "consultant@firm.co" },
        ]);
    });

    test("both present and distinct → returns both", () => {
        expect(mergeCcRecipients("audit@firm.co", "consultant@firm.co")).toEqual([
            { email: "audit@firm.co" },
            { email: "consultant@firm.co" },
        ]);
    });

    test("both present and equal → de-duplicated (address appears once)", () => {
        expect(mergeCcRecipients("shared@firm.co", "shared@firm.co")).toEqual([
            { email: "shared@firm.co" },
        ]);
    });

    test("equal but differing case / whitespace → de-duplicated", () => {
        expect(mergeCcRecipients("Shared@Firm.co", "  shared@firm.co  ")).toEqual([
            { email: "Shared@Firm.co" },
        ]);
    });

    test("overlapping multi-address strings → shared address appears once", () => {
        // Static has two, consultant repeats one of them plus a new one.
        expect(
            mergeCcRecipients("a@firm.co, b@firm.co", "b@firm.co; c@firm.co")
        ).toEqual([
            { email: "a@firm.co" },
            { email: "b@firm.co" },
            { email: "c@firm.co" },
        ]);
    });

    test("blank / whitespace consultant cell → falls back to static CC", () => {
        expect(mergeCcRecipients("audit@firm.co", "   ")).toEqual([
            { email: "audit@firm.co" },
        ]);
    });

    test("blank consultant cell and no static CC → nothing", () => {
        expect(mergeCcRecipients(undefined, "   ")).toBeUndefined();
    });

    test("blank / whitespace static CC → falls back to consultant CC", () => {
        expect(mergeCcRecipients("  ", "consultant@firm.co")).toEqual([
            { email: "consultant@firm.co" },
        ]);
    });

    test("neither present → returns nothing (no CC)", () => {
        expect(mergeCcRecipients(undefined, undefined)).toBeUndefined();
        expect(mergeCcRecipients("", "")).toBeUndefined();
    });

    test("empty address fragments from stray separators are dropped", () => {
        expect(mergeCcRecipients("a@firm.co,,", ";b@firm.co;")).toEqual([
            { email: "a@firm.co" },
            { email: "b@firm.co" },
        ]);
    });
});
