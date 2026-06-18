/**
 * Tests for the Specialised Audience module (issue #28).
 *
 * A specialised audience is split in two:
 *   - a per-audience **scan adapter** that owns the related-entity query, the
 *     collapse to one row per contact, and the in-memory membership test, and
 *   - one shared **resolver** that re-queries the scanned ids through Contact
 *     Query's `contactIds` dimension and joins each returned contact with its
 *     scan figure (and, when asked, its Tax Profile display figure).
 *
 * The Dynamics boundary is injected via the `request` option, so these tests
 * drive the real scan/dedup/membership and the real id-chunked re-query without
 * mocking modules. `fetchTaxProfilesFn` is likewise injected.
 */
import { describe, it, expect } from "vitest";
import {
    ita34IncomeScanAdapter,
    resolveSpecialisedAudience,
    type ScanAdapter,
} from "../specialisedAudience";
import type { DynamicsPage, DynamicsRequestFn } from "../contactQuery";
import type { TaxProfileData } from "../taxProfile";

/** A faked request boundary: serves queued pages by matching on the endpoint. */
function routedRequest(routes: Array<{ match: string; pages: Array<DynamicsPage<any>> }>) {
    const endpoints: string[] = [];
    const cursors = new Map<string, number>();
    const request: DynamicsRequestFn = async <T>(endpoint: string) => {
        endpoints.push(endpoint);
        const route = routes.find((r) => endpoint.includes(r.match));
        if (!route) return { value: [] } as unknown as T;
        const i = cursors.get(route.match) ?? 0;
        cursors.set(route.match, i + 1);
        return (route.pages[i] ?? { value: [] }) as unknown as T;
    };
    return { request, endpoints };
}

function ita34Row(contactId: string, year: number, income: number, retirementFund = 0) {
    return {
        _riivo_taxpayercontact_value: contactId,
        riivo_income: income,
        riivo_retirementfundcontributions: retirementFund,
        riivo_yearofassessment: year,
    };
}

const noSleep = async () => {};

describe("ita34IncomeScanAdapter", () => {
    it("collapses to each contact's latest year and tests income range on that row", async () => {
        const { request } = routedRequest([
            {
                match: "riivo_ita34s",
                pages: [
                    {
                        value: [
                            // c1: latest (2024) out of range, older (2021) in range → excluded.
                            ita34Row("c1", 2021, 150),
                            ita34Row("c1", 2024, 900),
                            // c2: latest (2024) in range → included.
                            ita34Row("c2", 2024, 200),
                            ita34Row("c2", 2019, 50),
                        ],
                    },
                ],
            },
        ]);

        const adapter = ita34IncomeScanAdapter({ incomeMin: 100, incomeMax: 300 });
        const result = await adapter.scan(request);

        expect(result.contactIds).toEqual(["c2"]);
        expect(result.figures.get("c2")).toBe(200);
    });

    it("does not emit an income clause server-side; retirement-fund and year are server-side", async () => {
        const { request, endpoints } = routedRequest([
            { match: "riivo_ita34s", pages: [{ value: [ita34Row("c1", 2024, 250)] }] },
        ]);

        const adapter = ita34IncomeScanAdapter({
            incomeMin: 100,
            incomeMax: 300,
            retirementFundMin: 10,
            taxYear: 2024,
        });
        await adapter.scan(request);

        const scan = endpoints.find((e) => e.includes("riivo_ita34s"))!;
        expect(scan).not.toContain("riivo_income ge");
        expect(scan).not.toContain("riivo_income le");
        expect(scan).toContain("riivo_retirementfundcontributions ge 10");
        expect(scan).toContain("riivo_yearofassessment eq 2024");
    });

    it("yields no ids when no latest row qualifies", async () => {
        const { request } = routedRequest([
            { match: "riivo_ita34s", pages: [{ value: [ita34Row("c1", 2024, 900)] }] },
        ]);
        const adapter = ita34IncomeScanAdapter({ incomeMin: 100, incomeMax: 300 });
        const result = await adapter.scan(request);
        expect(result.contactIds).toEqual([]);
    });
});

describe("resolveSpecialisedAudience", () => {
    function contactRow(contactid: string, fullname: string) {
        return { contactid, fullname };
    }

    it("re-queries scanned ids through the contactIds dimension and re-applies other clauses", async () => {
        const adapter: ScanAdapter = {
            async scan() {
                return {
                    contactIds: ["a", "b", "c"],
                    figures: new Map([["a", 1], ["b", 2], ["c", 3]]),
                };
            },
        };
        const { request, endpoints } = routedRequest([
            {
                match: "contacts?",
                pages: [
                    { value: [contactRow("a", "Alice"), contactRow("b", "Bob")] },
                    { value: [contactRow("c", "Carol")] },
                ],
            },
        ]);

        const out: Array<{ contact: any; extra: any }> = [];
        await resolveSpecialisedAudience<{ contactid: string; fullname: string }>({
            adapter,
            filter: { ownerId: "owner-1", clientType: [4] },
            select: "contactid,fullname",
            request,
            sleep: noSleep,
            contactIdChunkSize: 2,
            onChunk: (resolved) => {
                out.push(...resolved);
            },
        });

        expect(out.map((r) => r.contact.contactid)).toEqual(["a", "b", "c"]);
        // Scan figure joined onto each contact.
        expect(out.map((r) => r.extra.scanFigure)).toEqual([1, 2, 3]);
        // No taxProfile join requested.
        expect(out.every((r) => r.extra.taxProfile === null)).toBe(true);

        // Two id-chunks (ceiling 2), each carrying the other clauses + a contactid OR.
        const contactCalls = endpoints.filter((e) => e.includes("contacts?"));
        expect(contactCalls.length).toBe(2);
        for (const call of contactCalls) {
            expect(call).toContain("_ownerid_value eq 'owner-1'");
            expect(call).toContain("contactid eq");
            // The id set is never flattened into one clause.
            expect(call).not.toContain("contactid eq 'a' or contactid eq 'b' or contactid eq 'c'");
        }
    });

    it("joins the Tax Profile display figure when withTaxProfile is set", async () => {
        const adapter: ScanAdapter = {
            async scan() {
                return { contactIds: ["a"], figures: new Map([["a", 250]]) };
            },
        };
        const { request } = routedRequest([
            { match: "contacts?", pages: [{ value: [contactRow("a", "Alice")] }] },
        ]);

        const profile: TaxProfileData = {
            contactId: "a",
            ita34: {
                yearOfAssessment: 2024,
                income: 250,
                taxableIncome: 230,
                raContributions: 0,
                retirementFundContributions: 12,
                providentFundContributions: 0,
                medicalSchemeTaxCredit: 0,
                medicalRebate: 0,
                dateOfAssessment: null,
                referenceNumber: null,
            },
            irp5: null,
        };

        const out: Array<{ contact: any; extra: any }> = [];
        await resolveSpecialisedAudience<{ contactid: string; fullname: string }>({
            adapter,
            filter: {},
            select: "contactid,fullname",
            withTaxProfile: true,
            request,
            sleep: noSleep,
            fetchTaxProfilesFn: async (ids) => new Map(ids.map((id) => [id, profile])),
            onChunk: (resolved) => {
                out.push(...resolved);
            },
        });

        expect(out[0].extra.taxProfile?.ita34?.taxableIncome).toBe(230);
        expect(out[0].extra.scanFigure).toBe(250);
    });

    it("issues no contact request and joins no profiles for an empty scan", async () => {
        const adapter: ScanAdapter = {
            async scan() {
                return { contactIds: [], figures: new Map() };
            },
        };
        const { request, endpoints } = routedRequest([
            { match: "contacts?", pages: [{ value: [contactRow("a", "Alice")] }] },
        ]);
        let profilesFetched = false;

        const out: any[] = [];
        await resolveSpecialisedAudience<{ contactid: string; fullname: string }>({
            adapter,
            filter: {},
            select: "contactid,fullname",
            withTaxProfile: true,
            request,
            fetchTaxProfilesFn: async (ids) => {
                profilesFetched = true;
                return new Map();
            },
            onChunk: (resolved) => {
                out.push(...resolved);
            },
        });

        expect(out).toEqual([]);
        expect(endpoints.filter((e) => e.includes("contacts?"))).toEqual([]);
        expect(profilesFetched).toBe(false);
    });
});
