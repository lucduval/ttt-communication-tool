import { describe, test, expect } from "vitest";
import {
    buildLeadFilter,
    streamLeads,
    countLeads,
    fetchLeadsPage,
    type LeadFilter,
} from "../leadQuery";
import {
    escapeODataValue,
    type DynamicsPage,
    type DynamicsRequestFn,
} from "../contactQuery";

/**
 * A faked Dynamics request boundary: returns queued pages in order (or throws a
 * queued Error to exercise retry), and records every endpoint it was asked for.
 * Mirrors the Contact Query test harness.
 */
function fakeRequest(pages: Array<DynamicsPage<any> | Error>) {
    const endpoints: string[] = [];
    let i = 0;
    const request: DynamicsRequestFn = async <T>(endpoint: string) => {
        endpoints.push(endpoint);
        const next = pages[i++] ?? { value: [] };
        if (next instanceof Error) throw next;
        return next as unknown as T;
    };
    return { request, endpoints };
}

const noSleep = async () => {};

// ---- Characterization tests: pin the current lead filter output ----
//
// These lock the exact OData expression the hand-rolled lead filter builder in
// the Dynamics actions file produces today, so the later migration (#18) is
// provably behaviour-preserving.

describe("buildLeadFilter", () => {
    test("status active maps to statecode eq 0", () => {
        expect(buildLeadFilter({ status: "active" })).toBe("statecode eq 0");
    });

    test("status inactive maps to statecode eq 1", () => {
        expect(buildLeadFilter({ status: "inactive" })).toBe("statecode eq 1");
    });

    test("status all uses the always-true placeholder", () => {
        expect(buildLeadFilter({ status: "all" })).toBe("statecode ne -1");
    });

    test("an absent status uses the always-true placeholder", () => {
        expect(buildLeadFilter({})).toBe("statecode ne -1");
    });

    test("builds a contains() search clause over name and email", () => {
        expect(buildLeadFilter({ status: "active", search: "smith" })).toBe(
            "statecode eq 0 and (contains(new_name,'smith') or contains(ttt_email,'smith'))"
        );
    });

    test("escapes apostrophes in the search term", () => {
        expect(buildLeadFilter({ status: "active", search: "O'Brien" })).toBe(
            "statecode eq 0 and (contains(new_name,'O''Brien') or contains(ttt_email,'O''Brien'))"
        );
    });

    test("province is emitted as a quoted equality match with apostrophe escaping", () => {
        expect(buildLeadFilter({ status: "active", province: "KwaZulu'Natal" })).toBe(
            "statecode eq 0 and riivo_province eq 'KwaZulu''Natal'"
        );
    });

    test("email opt-in true and false are emitted as boolean equality", () => {
        expect(buildLeadFilter({ status: "active", emailOptIn: true })).toBe(
            "statecode eq 0 and riivo_emailoptin eq true"
        );
        expect(buildLeadFilter({ status: "active", emailOptIn: false })).toBe(
            "statecode eq 0 and riivo_emailoptin eq false"
        );
    });

    test("whatsapp opt-in true and false are emitted as boolean equality", () => {
        expect(buildLeadFilter({ status: "active", whatsappOptIn: true })).toBe(
            "statecode eq 0 and riivo_whatsappoptin eq true"
        );
        expect(buildLeadFilter({ status: "active", whatsappOptIn: false })).toBe(
            "statecode eq 0 and riivo_whatsappoptin eq false"
        );
    });

    test("owner id scopes by _ownerid_value", () => {
        expect(buildLeadFilter({ status: "active", ownerId: "abc-123" })).toBe(
            "statecode eq 0 and _ownerid_value eq 'abc-123'"
        );
    });

    test("industry id scopes by the lead industry lookup", () => {
        expect(buildLeadFilter({ status: "active", industryId: "ind-9" })).toBe(
            "statecode eq 0 and _riivo_industry_lookup_value eq 'ind-9'"
        );
    });

    test("characterizes the full clause ordering for a representative spread", () => {
        const filter: LeadFilter = {
            status: "all",
            search: "jo'hn",
            province: "Gauteng",
            emailOptIn: true,
            whatsappOptIn: false,
            ownerId: "owner-1",
            industryId: "industry-1",
        };
        expect(buildLeadFilter(filter)).toBe(
            "statecode ne -1" +
                " and (contains(new_name,'jo''hn') or contains(ttt_email,'jo''hn'))" +
                " and riivo_province eq 'Gauteng'" +
                " and riivo_emailoptin eq true" +
                " and riivo_whatsappoptin eq false" +
                " and _ownerid_value eq 'owner-1'" +
                " and _riivo_industry_lookup_value eq 'industry-1'"
        );
    });

    test("a resolved non-admin effective owner always appears in the produced filter", () => {
        expect(buildLeadFilter({ ownerId: "consultant-7" })).toContain(
            "_ownerid_value eq 'consultant-7'"
        );
    });
});

describe("shared value-escaping helper", () => {
    test("the lead path uses the same escaping as contacts (consolidation, not a change)", () => {
        expect(escapeODataValue("O'Brien")).toBe("O''Brien");
        expect(buildLeadFilter({ status: "active", search: "O'Brien" })).toContain(
            "contains(new_name,'O''Brien')"
        );
    });
});

describe("streamLeads", () => {
    test("pages through nextLinks until exhausted, normalizing each cursor", async () => {
        const { request, endpoints } = fakeRequest([
            {
                value: [{ new_leadid: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/new_leads?$skiptoken=p2",
            },
            { value: [{ new_leadid: "2" }] },
        ]);

        const collected: Array<{ new_leadid: string }> = [];
        await streamLeads<{ new_leadid: string }>(
            { status: "active" },
            {
                select: "new_leadid",
                request,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );

        expect(collected.map((c) => c.new_leadid)).toEqual(["1", "2"]);
        // First call builds the filter from the typed object and targets new_leads.
        expect(endpoints[0]).toBe(
            "new_leads?$filter=statecode eq 0&$select=new_leadid&$orderby=new_name asc"
        );
        // Second call is the normalized cursor — no base URL.
        expect(endpoints[1]).toBe("new_leads?$skiptoken=p2");
    });

    test("a resolved owner always appears in the produced filter", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await streamLeads(
            { status: "active", ownerId: "owner-42" },
            { select: "new_leadid", request, onPage: () => {} }
        );
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-42'");
    });

    test("retries a failing page with exponential backoff before succeeding", async () => {
        let attempts = 0;
        const request: DynamicsRequestFn = async <T>() => {
            attempts++;
            if (attempts < 3) throw new Error("boom");
            return { value: [{ new_leadid: "ok" }] } as unknown as T;
        };
        const slept: number[] = [];
        const collected: Array<{ new_leadid: string }> = [];
        await streamLeads<{ new_leadid: string }>(
            { status: "active" },
            {
                select: "new_leadid",
                request,
                sleep: async (ms) => {
                    slept.push(ms);
                },
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );
        expect(attempts).toBe(3);
        expect(slept).toEqual([1000, 2000]);
        expect(collected.map((c) => c.new_leadid)).toEqual(["ok"]);
    });

    test("throws after exhausting retries", async () => {
        const request: DynamicsRequestFn = async <T>() => {
            throw new Error("always");
        };
        await expect(
            streamLeads(
                { status: "active" },
                { select: "new_leadid", request, sleep: noSleep, onPage: () => {} }
            )
        ).rejects.toThrow("always");
    });
});

describe("countLeads", () => {
    test("returns the odata count when below the ceiling", async () => {
        const { request, endpoints } = fakeRequest([{ "@odata.count": 42, value: [] }]);
        expect(await countLeads({ status: "active" }, { request })).toBe(42);
        expect(endpoints[0]).toBe(
            "new_leads?$filter=statecode eq 0&$count=true&$top=1&$select=new_leadid"
        );
    });

    test("paginates lead ids when the count hits the ceiling", async () => {
        const { request, endpoints } = fakeRequest([
            { "@odata.count": 5000, value: [{ new_leadid: "probe" }] },
            {
                value: [{ new_leadid: "1" }, { new_leadid: "2" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/new_leads?$skiptoken=p2",
            },
            { value: [{ new_leadid: "3" }] },
        ]);
        expect(await countLeads({ status: "active" }, { request, ceiling: 5000 })).toBe(3);
        expect(endpoints[1]).toBe(
            "new_leads?$filter=statecode eq 0&$select=new_leadid&$count=true"
        );
    });

    test("a resolved owner always appears in the count filter", async () => {
        const { request, endpoints } = fakeRequest([{ "@odata.count": 0, value: [] }]);
        await countLeads({ status: "active", ownerId: "owner-7" }, { request });
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-7'");
    });
});

describe("recipient list, count, and select-all agree", () => {
    test("all three facades derive the same filter expression from one LeadFilter", async () => {
        const filter: LeadFilter = {
            status: "active",
            search: "O'Brien",
            province: "Gauteng",
            emailOptIn: true,
            ownerId: "owner-9",
            industryId: "ind-3",
        };

        // The recipient list (fetchLeadsPage), the count (countLeads), and
        // select-all (streamLeads) must all target the identical $filter, so the
        // audience counted is the audience listed and sent.
        const page = fakeRequest([{ value: [] }]);
        await fetchLeadsPage(filter, { select: "new_leadid", pageSize: 50, request: page.request });

        const count = fakeRequest([{ "@odata.count": 0, value: [] }]);
        await countLeads(filter, { request: count.request });

        const stream = fakeRequest([{ value: [] }]);
        await streamLeads(filter, { select: "new_leadid", request: stream.request, onPage: () => {} });

        const expected = buildLeadFilter(filter);
        const filterOf = (endpoint: string) =>
            endpoint.match(/\$filter=([^&]*)/)?.[1];

        expect(filterOf(page.endpoints[0])).toBe(expected);
        expect(filterOf(count.endpoints[0])).toBe(expected);
        expect(filterOf(stream.endpoints[0])).toBe(expected);
    });
});

describe("fetchLeadsPage", () => {
    test("builds a single page request with a page-size header and returns the raw page", async () => {
        const { request, endpoints } = fakeRequest([
            {
                value: [{ new_leadid: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/new_leads?$skiptoken=p2",
            },
        ]);
        const page = await fetchLeadsPage(
            { status: "active" },
            { select: "new_leadid", pageSize: 50, request }
        );
        expect(page.value).toEqual([{ new_leadid: "1" }]);
        expect(endpoints[0]).toBe(
            "new_leads?$select=new_leadid&$filter=statecode eq 0&$orderby=new_name asc"
        );
    });

    test("follows a provided cursor verbatim after normalizing it", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await fetchLeadsPage(
            { status: "active" },
            {
                select: "new_leadid",
                pageSize: 50,
                cursor:
                    "https://org.api.crm.dynamics.com/api/data/v9.2/new_leads?$skiptoken=p2",
                request,
            }
        );
        expect(endpoints[0]).toBe("new_leads?$skiptoken=p2");
    });
});
