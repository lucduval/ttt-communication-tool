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
    sample,
    selectedContactIds,
    toCampaignArgs,
    filteredSelection,
    deselectContact,
    reselectContact,
    isFiltered,
    excludedContactIds,
    uploadSelection,
    type SelectableContact,
    type FilterPayload,
    type CampaignRecipient,
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

    describe("sample projection", () => {
        it("returns the first n hand-picks in selection order", () => {
            expect(sample(explicitSelection([alice, bob, carol]), 2)).toEqual([alice, bob]);
        });

        it("returns all contacts when n exceeds the count", () => {
            expect(sample(explicitSelection([alice, bob]), 8)).toEqual([alice, bob]);
        });

        it("returns an empty array for a non-positive n", () => {
            expect(sample(explicitSelection([alice, bob]), 0)).toEqual([]);
            expect(sample(explicitSelection([alice, bob]), -1)).toEqual([]);
        });

        it("returns an empty array for an empty selection", () => {
            expect(sample(emptySelection(), 8)).toEqual([]);
        });

        it("does not mutate the selection", () => {
            const sel = explicitSelection([alice, bob, carol]);
            sample(sel, 1);
            expect(count(sel)).toBe(3);
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

describe("recipientSelection — filtered shape", () => {
    // A representative Contact Query filter, as the page captures it at select-all time.
    const clientsFilter: FilterPayload = {
        filter: "email",
        search: "joh",
        province: "Gauteng",
    };

    describe("transitions", () => {
        it("activate captures the filter and the known total, with no exclusions", () => {
            const sel = filteredSelection(clientsFilter, 1200);
            expect(sel.shape).toBe("filtered");
            expect(isFiltered(sel)).toBe(true);
            expect(count(sel)).toBe(1200);
            expect([...excludedContactIds(sel)]).toEqual([]);
        });

        it("deselect excludes a contact; count drops by the exclusion", () => {
            let sel = filteredSelection(clientsFilter, 10);
            sel = deselectContact(sel, "a");
            sel = deselectContact(sel, "b");
            expect(count(sel)).toBe(8);
            expect([...excludedContactIds(sel)]).toEqual(["a", "b"]);
        });

        it("deselect is idempotent (no duplicate exclusions)", () => {
            let sel = filteredSelection(clientsFilter, 10);
            sel = deselectContact(sel, "a");
            sel = deselectContact(sel, "a");
            expect(count(sel)).toBe(9);
            expect([...excludedContactIds(sel)]).toEqual(["a"]);
        });

        it("reselect removes a prior exclusion; count climbs back", () => {
            let sel = filteredSelection(clientsFilter, 10);
            sel = deselectContact(sel, "a");
            sel = deselectContact(sel, "b");
            sel = reselectContact(sel, "a");
            expect(count(sel)).toBe(9);
            expect([...excludedContactIds(sel)]).toEqual(["b"]);
        });

        it("count never goes below zero", () => {
            let sel = filteredSelection(clientsFilter, 1);
            sel = deselectContact(sel, "a");
            sel = deselectContact(sel, "b");
            expect(count(sel)).toBe(0);
        });

        it("sample is empty in the filtered shape (the page fetches it via a query)", () => {
            expect(sample(filteredSelection(clientsFilter, 1200), 8)).toEqual([]);
        });

        it("selectedContactIds is empty in the filtered shape (checks are driven by exclusions)", () => {
            const sel = deselectContact(filteredSelection(clientsFilter, 10), "a");
            expect([...selectedContactIds(sel)]).toEqual([]);
        });

        it("transitions never mutate the input value", () => {
            const sel = filteredSelection(clientsFilter, 10);
            deselectContact(sel, "a");
            expect(count(sel)).toBe(10);
            expect([...excludedContactIds(sel)]).toEqual([]);
        });

        it("activate copies the filter object (no aliasing)", () => {
            const input: FilterPayload = { filter: "email" };
            const sel = filteredSelection(input, 5);
            input.search = "mutated";
            expect(toCampaignArgs(sel, { channel: "email" }).filters).toBe(
                JSON.stringify({ filter: "email" }),
            );
        });
    });

    describe("one shape at a time (mutual exclusivity)", () => {
        it("hand-picking clears a filtered selection", () => {
            const filtered = deselectContact(filteredSelection(clientsFilter, 10), "x");
            const sel = toggleContact(filtered, alice);
            expect(sel.shape).toBe("explicit");
            expect(isFiltered(sel)).toBe(false);
            expect([...selectedContactIds(sel)]).toEqual(["a"]);
        });

        it("activating filtered select-all clears hand-picks", () => {
            const explicit = explicitSelection([alice, bob]);
            expect(explicit.shape).toBe("explicit");
            const sel = filteredSelection(clientsFilter, 10);
            expect(sel.shape).toBe("filtered");
            expect(count(sel)).toBe(10);
        });

        it("deselect on an explicit selection is a no-op", () => {
            const sel = explicitSelection([alice, bob]);
            expect(deselectContact(sel, "a")).toEqual(sel);
        });
    });

    describe("toCampaignArgs projection", () => {
        it("yields { filters } JSON carrying the filter (no recipients) and no excludeContactIds when none", () => {
            const args = toCampaignArgs(filteredSelection(clientsFilter, 10), { channel: "email" });
            expect(args.recipients).toBeUndefined();
            expect(JSON.parse(args.filters!)).toEqual(clientsFilter);
        });

        it("carries excludeContactIds when contacts have been unchecked", () => {
            let sel = filteredSelection(clientsFilter, 10);
            sel = deselectContact(sel, "a");
            sel = deselectContact(sel, "b");
            const args = toCampaignArgs(sel, { channel: "whatsapp" });
            expect(JSON.parse(args.filters!)).toEqual({
                ...clientsFilter,
                excludeContactIds: ["a", "b"],
            });
        });

        it("the filter payload is channel-independent (the backend re-resolves)", () => {
            const sel = filteredSelection(clientsFilter, 10);
            expect(toCampaignArgs(sel, { channel: "email" })).toEqual(
                toCampaignArgs(sel, { channel: "whatsapp" }),
            );
        });
    });
});

describe("recipientSelection — upload shape (#65)", () => {
    // Recipients as `prepareUploadForSend` materialises them: tracking-key
    // identity in `id`, send address, no name role (""), full-row merge bag.
    const r1: CampaignRecipient = {
        id: "11111111-1111-1111-1111-111111111111",
        name: "",
        email: "alice@example.com",
        variables: JSON.stringify({ Amount: "R1,200.00", Contact: "…" }),
    };
    const r2: CampaignRecipient = {
        id: "22222222-2222-2222-2222-222222222222",
        name: "",
        email: "bob@example.com",
        variables: JSON.stringify({ Amount: "R980.00", Contact: "…" }),
    };

    describe("transitions", () => {
        it("holds the materialised recipients verbatim", () => {
            const sel = uploadSelection([r1, r2]);
            expect(sel.shape).toBe("upload");
            expect(count(sel)).toBe(2);
        });

        it("copies the array so later caller mutation cannot alter the selection", () => {
            const source = [r1];
            const sel = uploadSelection(source);
            source.push(r2);
            expect(count(sel)).toBe(1);
        });

        it("is not the filtered shape", () => {
            expect(isFiltered(uploadSelection([r1]))).toBe(false);
        });

        it("exposes no checkbox/excluded ids (its recipients are pre-materialised)", () => {
            const sel = uploadSelection([r1, r2]);
            expect(selectedContactIds(sel)).toEqual(new Set());
            expect(excludedContactIds(sel)).toEqual(new Set());
        });

        it("clears back to an empty explicit selection", () => {
            const sel = uploadSelection([r1, r2]);
            expect(count(clearSelection())).toBe(0);
            expect(count(sel)).toBe(2); // original value is immutable
        });
    });

    describe("toCampaignArgs projection", () => {
        it("hands the recipients straight to the send path, unchanged", () => {
            const args = toCampaignArgs(uploadSelection([r1, r2]), { channel: "email" });
            expect(args.filters).toBeUndefined();
            expect(args.recipients).toEqual([r1, r2]);
        });

        it("preserves the JSON variables bag so the email adapter can merge by column", () => {
            const args = toCampaignArgs(uploadSelection([r1]), { channel: "email" });
            expect(JSON.parse(args.recipients![0].variables!)).toEqual({
                Amount: "R1,200.00",
                Contact: "…",
            });
        });

        it("is channel-independent — the row cells are already the source of truth", () => {
            const sel = uploadSelection([r1, r2]);
            expect(toCampaignArgs(sel, { channel: "whatsapp" })).toEqual(
                toCampaignArgs(sel, { channel: "email" }),
            );
        });

        it("carries a WhatsApp recipient's phone through to the send path unchanged (#85)", () => {
            // An uploaded WhatsApp recipient materialises with a phone destination
            // (no email); the projection must hand it straight through so the
            // sender's phone lookup + E.164 normalisation resolve.
            const wa: CampaignRecipient = {
                id: "33333333-3333-3333-3333-333333333333",
                name: "",
                phone: "+27821234567",
                variables: JSON.stringify({ "1": "Alice" }),
            };
            const args = toCampaignArgs(uploadSelection([wa]), { channel: "whatsapp" });
            expect(args.recipients).toEqual([wa]);
            expect(args.recipients![0].phone).toBe("+27821234567");
            expect(args.recipients![0].email).toBeUndefined();
        });
    });
});
