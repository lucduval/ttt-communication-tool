/**
 * Tests for the send-path ITA34 audience (issue #26).
 *
 * `fetchMatchingContactsWithITA34` is the send-time sibling of the recipient
 * list's `fetchContactsWithITA34`. #25 fixed the list so an income range is
 * tested against each contact's *latest* ITA34 row; this path must agree, or a
 * select-all income campaign sends to contacts the advisor never saw in the list.
 *
 * The Dynamics boundary is faked; the scan's latest-year collapse + in-memory
 * range test run for real through the Specialised Audience module. That module
 * (and Contact Query / Tax Profile beneath it) reaches Dynamics via the
 * low-level `dynamics_auth` primitive, so that is the seam we fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const boundary = vi.hoisted(() => ({
    dynamicsRequest: vi.fn(),
}));

vi.mock("../dynamics_auth", () => ({
    dynamicsRequest: boundary.dynamicsRequest,
}));

import { fetchMatchingContactsWithITA34, type CampaignFilters, type ShimmedContact } from "../dynamics_util";

function ita34Row(contactId: string, year: number, income: number) {
    return {
        _riivo_taxpayercontact_value: contactId,
        riivo_income: income,
        riivo_retirementfundcontributions: 0,
        riivo_yearofassessment: year,
    };
}

function contactRow(contactId: string, fullname: string) {
    return {
        contactid: contactId,
        fullname,
        emailaddress1: `${contactId}@example.com`,
        mobilephone: null,
        icon_formattedmobilenumber: null,
        riivo_referralcode: null,
    };
}

async function collect(filters: CampaignFilters): Promise<ShimmedContact[]> {
    const out: ShimmedContact[] = [];
    await fetchMatchingContactsWithITA34(filters, async (chunk) => {
        out.push(...chunk);
    });
    return out;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("fetchMatchingContactsWithITA34 (faked Dynamics boundary)", () => {
    it("excludes a contact whose latest-year income is out of range even when an older year was in range", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return {
                    value: [
                        // c1: latest year (2024) is OUT of range; old year (2021) was in range.
                        ita34Row("c1", 2021, 150),
                        ita34Row("c1", 2024, 900),
                        // c2: latest year (2024) is in range.
                        ita34Row("c2", 2024, 200),
                    ],
                };
            }
            if (path.includes("contacts?")) {
                // Only c2 should reach the contact fetch.
                return { value: [contactRow("c2", "Carol Two")] };
            }
            return { value: [] };
        });

        const result = await collect({ incomeMin: 100, incomeMax: 300 });

        expect(result.map((c) => c.id)).toEqual(["c2"]);
        // The income range must NOT be sent as an OData clause over all years.
        const ita34Calls = boundary.dynamicsRequest.mock.calls
            .map((c) => c[0] as string)
            .filter((p) => p.includes("riivo_ita34s"));
        expect(ita34Calls.length).toBeGreaterThan(0);
        for (const path of ita34Calls) {
            expect(path).not.toContain("riivo_income ge");
            expect(path).not.toContain("riivo_income le");
        }
    });

    it("includes a contact whose latest-year income is in range", async () => {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                return { value: [ita34Row("c1", 2023, 50), ita34Row("c1", 2024, 250)] };
            }
            if (path.includes("contacts?")) {
                return { value: [contactRow("c1", "Alice One")] };
            }
            return { value: [] };
        });

        const result = await collect({ incomeMin: 100, incomeMax: 300 });
        expect(result.map((c) => c.id)).toEqual(["c1"]);
    });
});
