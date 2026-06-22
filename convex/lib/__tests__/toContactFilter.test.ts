/**
 * Tests for the campaign → Contact Query filter adaptation (issue #49).
 *
 * `toContactFilter` adapts the campaign-shaped `CampaignFilters` to the typed
 * `ContactFilter` the Contact Query module understands. The uploaded-audience
 * keystone (#49) is the `contactIds` set: a filtered selection carrying
 * `{ contactIds }` must stream through Contact Query's `contactIds` dimension at
 * send time, exactly like any other filtered campaign. `ContactFilter` and
 * `streamContacts` already own that dimension; the only gap was upstream — the
 * field had to exist on `CampaignFilters` and be carried through here.
 */
import { describe, it, expect } from "vitest";

import { toContactFilter, type CampaignFilters } from "../dynamics_util";

describe("toContactFilter — contactIds dimension (#49)", () => {
    it("carries a contactIds set through to the typed ContactFilter", () => {
        const ids = [
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        ];
        const filters: CampaignFilters = { contactIds: ids };

        expect(toContactFilter(filters).contactIds).toEqual(ids);
    });

    it("leaves contactIds absent when no id set is supplied", () => {
        expect(toContactFilter({}).contactIds).toBeUndefined();
    });

    it("preserves the contactIds set alongside other filter dimensions", () => {
        const ids = ["33333333-3333-3333-3333-333333333333"];
        const result = toContactFilter({ ownerId: "owner-1", contactIds: ids });

        expect(result.contactIds).toEqual(ids);
        expect(result.ownerId).toBe("owner-1");
    });
});
