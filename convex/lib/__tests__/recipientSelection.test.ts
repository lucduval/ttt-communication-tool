/**
 * Recipient Selection pure-core tests (issue #19).
 *
 * The selection value and its projections are the test surface — no React, no
 * Convex. These pin the explicit shape's transitions (toggle, clear, set), the
 * `count` projection, and the `toCampaignArgs` projection producing exactly the
 * `recipients[]` payload the send path produced before the module existed.
 */
import { describe, it, expect } from "vitest";
import {
    emptySelection,
    explicitSelection,
    toggleContact,
    clearSelection,
    count,
    selectedContactIds,
    toCampaignArgs,
    type SelectableContact,
} from "../recipientSelection";

const alice: SelectableContact = {
    id: "a",
    fullName: "Alice",
    email: "alice@example.com",
    phone: "0710000001",
    internationalPhone: "+27710000001",
};
const bob: SelectableContact = {
    id: "b",
    fullName: "Bob",
    email: "bob@example.com",
    phone: null,
    internationalPhone: null,
};
const carol: SelectableContact = {
    // reachable by phone only (no email)
    id: "c",
    fullName: "Carol",
    email: null,
    phone: "0710000003",
    internationalPhone: null,
};

describe("recipientSelection — explicit shape", () => {
    describe("transitions", () => {
        it("starts empty", () => {
            const sel = emptySelection();
            expect(sel.shape).toBe("explicit");
            expect(count(sel)).toBe(0);
        });

        it("toggle adds a contact when absent", () => {
            const sel = toggleContact(emptySelection(), alice);
            expect(count(sel)).toBe(1);
            expect([...selectedContactIds(sel)]).toEqual(["a"]);
        });

        it("toggle removes a contact when already present (matched by id)", () => {
            const sel = toggleContact(toggleContact(emptySelection(), alice), alice);
            expect(count(sel)).toBe(0);
        });

        it("toggle preserves insertion order of survivors", () => {
            let sel = emptySelection();
            sel = toggleContact(sel, alice);
            sel = toggleContact(sel, bob);
            sel = toggleContact(sel, carol);
            sel = toggleContact(sel, bob); // remove the middle one
            expect([...selectedContactIds(sel)]).toEqual(["a", "c"]);
        });

        it("explicitSelection replaces with exactly the given contacts", () => {
            const sel = explicitSelection([alice, bob]);
            expect(count(sel)).toBe(2);
            expect([...selectedContactIds(sel)]).toEqual(["a", "b"]);
        });

        it("explicitSelection copies the input array (no aliasing)", () => {
            const input = [alice];
            const sel = explicitSelection(input);
            input.push(bob);
            expect(count(sel)).toBe(1);
        });

        it("clear returns to empty", () => {
            const sel = explicitSelection([alice, bob]);
            expect(count(clearSelection())).toBe(0);
            // original value is untouched (transitions are pure)
            expect(count(sel)).toBe(2);
        });

        it("transitions never mutate the input value", () => {
            const sel = explicitSelection([alice]);
            toggleContact(sel, bob);
            expect(count(sel)).toBe(1);
        });
    });

    describe("count projection", () => {
        it("returns the number of selected contacts", () => {
            expect(count(explicitSelection([alice, bob, carol]))).toBe(3);
        });
    });

    describe("toCampaignArgs projection", () => {
        it("email yields { id, email, name } for contacts with an email", () => {
            const args = toCampaignArgs(explicitSelection([alice, bob, carol]), {
                channel: "email",
            });
            expect(args.recipients).toEqual([
                { id: "a", email: "alice@example.com", name: "Alice" },
                { id: "b", email: "bob@example.com", name: "Bob" },
            ]);
        });

        it("personalised yields the same email payload as email", () => {
            const sel = explicitSelection([alice, carol]);
            expect(toCampaignArgs(sel, { channel: "personalised" })).toEqual(
                toCampaignArgs(sel, { channel: "email" }),
            );
        });

        it("whatsapp prefers international phone, falls back to local, and carries variables", () => {
            const args = toCampaignArgs(explicitSelection([alice, bob, carol]), {
                channel: "whatsapp",
                whatsappVariables: '{"1":"hi"}',
            });
            expect(args.recipients).toEqual([
                { id: "a", phone: "+27710000001", name: "Alice", variables: '{"1":"hi"}' },
                { id: "c", phone: "0710000003", name: "Carol", variables: '{"1":"hi"}' },
            ]);
        });

        it("whatsapp drops contacts with no phone at all", () => {
            const args = toCampaignArgs(explicitSelection([bob]), { channel: "whatsapp" });
            expect(args.recipients).toEqual([]);
        });

        it("empty selection yields no recipients", () => {
            expect(toCampaignArgs(emptySelection(), { channel: "email" }).recipients).toEqual([]);
        });
    });
});
