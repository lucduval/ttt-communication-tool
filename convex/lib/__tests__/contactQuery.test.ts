import { describe, test, expect } from "vitest";
import {
    buildContactFilter,
    buildContactFilterClauses,
    escapeODataValue,
    normalizeEndpoint,
    streamContacts,
    countContacts,
    fetchContactsPage,
    type ContactFilter,
    type DynamicsPage,
    type DynamicsRequestFn,
} from "../contactQuery";

/**
 * A faked Dynamics request boundary: returns queued pages in order (or throws a
 * queued Error to exercise retry), and records every endpoint it was asked for.
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

describe("buildContactFilter", () => {
    test("returns the active-only base filter for an empty filter object", () => {
        expect(buildContactFilter({})).toBe("statecode eq 0");
    });

    test("wraps a raw passthrough filter in parentheses", () => {
        expect(buildContactFilter({ filter: "riivo_taxmarketing eq true" })).toBe(
            "statecode eq 0 and (riivo_taxmarketing eq true)"
        );
    });

    test("builds a contains() search clause over fullname and email", () => {
        expect(buildContactFilter({ search: "smith" })).toBe(
            "statecode eq 0 and (contains(fullname,'smith') or contains(emailaddress1,'smith'))"
        );
    });

    test("escapes apostrophes in the search term", () => {
        expect(buildContactFilter({ search: "O'Brien" })).toBe(
            "statecode eq 0 and (contains(fullname,'O''Brien') or contains(emailaddress1,'O''Brien'))"
        );
    });

    test("client type is emitted as multi-select containment", () => {
        expect(buildContactFilter({ clientType: [4, 5] })).toBe(
            "statecode eq 0 and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4','5'])"
        );
    });

    test("an empty client type array contributes nothing", () => {
        expect(buildContactFilter({ clientType: [] })).toBe("statecode eq 0");
    });

    test("entity type and bank are emitted as numeric equality", () => {
        expect(buildContactFilter({ entityType: 1, bank: 3 })).toBe(
            "statecode eq 0 and riivo_clienttypeindbus eq 1 and ttt_bank eq 3"
        );
    });

    test("entity type and bank of 0 are still emitted (not treated as absent)", () => {
        expect(buildContactFilter({ entityType: 0, bank: 0 })).toBe(
            "statecode eq 0 and riivo_clienttypeindbus eq 0 and ttt_bank eq 0"
        );
    });

    test("source code is emitted as multi-select containment", () => {
        expect(buildContactFilter({ sourceCode: [1, 2, 3] })).toBe(
            "statecode eq 0 and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['1','2','3'])"
        );
    });

    test("an empty source code array contributes nothing", () => {
        expect(buildContactFilter({ sourceCode: [] })).toBe("statecode eq 0");
    });

    test("province is emitted as a quoted equality match with apostrophe escaping", () => {
        expect(buildContactFilter({ province: "KwaZulu'Natal" })).toBe(
            "statecode eq 0 and address1_stateorprovince eq 'KwaZulu''Natal'"
        );
    });

    test("geographic location is emitted as numeric equality", () => {
        expect(buildContactFilter({ geographicLocation: 5 })).toBe(
            "statecode eq 0 and riivo_geographiclocation eq 5"
        );
    });

    test("age min and max are emitted as ge/le", () => {
        expect(buildContactFilter({ ageMin: 18, ageMax: 65 })).toBe(
            "statecode eq 0 and riivo_age ge 18 and riivo_age le 65"
        );
    });

    test("owner id scopes by _ownerid_value", () => {
        expect(buildContactFilter({ ownerId: "abc-123" })).toBe(
            "statecode eq 0 and _ownerid_value eq 'abc-123'"
        );
    });

    test("industry id scopes by _riivo_industryid_value", () => {
        expect(buildContactFilter({ industryId: "ind-9" })).toBe(
            "statecode eq 0 and _riivo_industryid_value eq 'ind-9'"
        );
    });

    test("an alphabetical name range emits fullname ge / lt bounds", () => {
        expect(buildContactFilter({ nameRangeStart: "A", nameRangeEnd: "F" })).toBe(
            "statecode eq 0 and fullname ge 'A' and fullname lt 'G'"
        );
    });

    test("a name range ending at Z omits the upper bound", () => {
        expect(buildContactFilter({ nameRangeStart: "M", nameRangeEnd: "Z" })).toBe(
            "statecode eq 0 and fullname ge 'M'"
        );
    });

    test("characterizes the full clause ordering for a representative spread", () => {
        const filter: ContactFilter = {
            filter: "riivo_taxmarketing eq true",
            search: "jo'hn",
            clientType: [4, 5],
            entityType: 2,
            bank: 1,
            sourceCode: [10, 20],
            province: "Gauteng",
            geographicLocation: 7,
            ageMin: 25,
            ageMax: 40,
            ownerId: "owner-1",
            industryId: "industry-1",
        };
        expect(buildContactFilter(filter)).toBe(
            "statecode eq 0" +
                " and (riivo_taxmarketing eq true)" +
                " and (contains(fullname,'jo''hn') or contains(emailaddress1,'jo''hn'))" +
                " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4','5'])" +
                " and riivo_clienttypeindbus eq 2" +
                " and ttt_bank eq 1" +
                " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['10','20'])" +
                " and address1_stateorprovince eq 'Gauteng'" +
                " and riivo_geographiclocation eq 7" +
                " and riivo_age ge 25" +
                " and riivo_age le 40" +
                " and _ownerid_value eq 'owner-1'" +
                " and _riivo_industryid_value eq 'industry-1'"
        );
    });
});

describe("buildContactFilterClauses", () => {
    test("returns an empty string for an empty filter object", () => {
        expect(buildContactFilterClauses({})).toBe("");
    });

    test("emits the appended clauses without the active-only base", () => {
        expect(buildContactFilterClauses({ clientType: [4, 5], ageMin: 30 })).toBe(
            " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4','5']) and riivo_age ge 30"
        );
    });

    test("buildContactFilter is the active-only base concatenated with the clauses", () => {
        const filter: ContactFilter = {
            filter: "riivo_taxmarketing eq true",
            search: "jo'hn",
            clientType: [4, 5],
            entityType: 2,
            bank: 1,
            sourceCode: [10, 20],
            province: "Gauteng",
            geographicLocation: 7,
            ageMin: 25,
            ageMax: 40,
            ownerId: "owner-1",
            industryId: "industry-1",
            nameRangeStart: "A",
            nameRangeEnd: "F",
        };
        expect(buildContactFilter(filter)).toBe("statecode eq 0" + buildContactFilterClauses(filter));
    });

    test("characterizes the extra-filter clause ordering for a representative spread", () => {
        const filter: ContactFilter = {
            filter: "riivo_taxmarketing eq true",
            search: "jo'hn",
            clientType: [4, 5],
            entityType: 2,
            bank: 1,
            sourceCode: [10, 20],
            province: "Gauteng",
            geographicLocation: 7,
            ageMin: 25,
            ageMax: 40,
            ownerId: "owner-1",
            industryId: "industry-1",
            nameRangeStart: "A",
            nameRangeEnd: "F",
        };
        expect(buildContactFilterClauses(filter)).toBe(
            " and (riivo_taxmarketing eq true)" +
                " and (contains(fullname,'jo''hn') or contains(emailaddress1,'jo''hn'))" +
                " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4','5'])" +
                " and riivo_clienttypeindbus eq 2" +
                " and ttt_bank eq 1" +
                " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['10','20'])" +
                " and address1_stateorprovince eq 'Gauteng'" +
                " and riivo_geographiclocation eq 7" +
                " and riivo_age ge 25" +
                " and riivo_age le 40" +
                " and _ownerid_value eq 'owner-1'" +
                " and _riivo_industryid_value eq 'industry-1'" +
                " and fullname ge 'A'" +
                " and fullname lt 'G'"
        );
    });
});

describe("escapeODataValue", () => {
    test("doubles single quotes", () => {
        expect(escapeODataValue("O'Brien")).toBe("O''Brien");
    });

    test("leaves values without apostrophes unchanged", () => {
        expect(escapeODataValue("Gauteng")).toBe("Gauteng");
    });
});

describe("normalizeEndpoint", () => {
    test("strips the Dynamics Web API base prefix from a full nextLink", () => {
        expect(
            normalizeEndpoint(
                "https://org.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=abc"
            )
        ).toBe("contacts?$skiptoken=abc");
    });

    test("leaves a relative endpoint unchanged", () => {
        expect(normalizeEndpoint("contacts?$filter=statecode eq 0")).toBe(
            "contacts?$filter=statecode eq 0"
        );
    });
});

describe("streamContacts", () => {
    test("pages through nextLinks until exhausted, normalizing each cursor", async () => {
        const { request, endpoints } = fakeRequest([
            {
                value: [{ contactid: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=p2",
            },
            { value: [{ contactid: "2" }] },
        ]);

        const collected: Array<{ contactid: string }> = [];
        await streamContacts<{ contactid: string }>(
            { clientType: [4] },
            {
                select: "contactid",
                request,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );

        expect(collected.map((c) => c.contactid)).toEqual(["1", "2"]);
        // First call builds the filter from the typed object.
        expect(endpoints[0]).toContain(
            "$filter=statecode eq 0 and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4'])"
        );
        // Second call is the normalized cursor — no base URL.
        expect(endpoints[1]).toBe("contacts?$skiptoken=p2");
    });

    test("a resolved owner always appears in the produced filter", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await streamContacts(
            { ownerId: "owner-42" },
            { select: "contactid", request, onPage: () => {} }
        );
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-42'");
    });

    test("retries a failing page with exponential backoff before succeeding", async () => {
        let attempts = 0;
        const request: DynamicsRequestFn = async <T>() => {
            attempts++;
            if (attempts < 3) throw new Error("boom");
            return { value: [{ contactid: "ok" }] } as unknown as T;
        };
        const slept: number[] = [];
        const collected: Array<{ contactid: string }> = [];
        await streamContacts<{ contactid: string }>(
            {},
            {
                select: "contactid",
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
        expect(collected.map((c) => c.contactid)).toEqual(["ok"]);
    });

    test("throws after exhausting retries", async () => {
        const request: DynamicsRequestFn = async <T>() => {
            throw new Error("always");
        };
        await expect(
            streamContacts(
                {},
                { select: "contactid", request, sleep: noSleep, onPage: () => {} }
            )
        ).rejects.toThrow("always");
    });
});

describe("countContacts", () => {
    test("returns the odata count when below the ceiling", async () => {
        const { request } = fakeRequest([{ "@odata.count": 42, value: [] }]);
        expect(await countContacts({}, { request })).toBe(42);
    });

    test("paginates contact ids when the count hits the ceiling", async () => {
        const { request } = fakeRequest([
            { "@odata.count": 5000, value: [{ contactid: "probe" }] },
            {
                value: [{ contactid: "1" }, { contactid: "2" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=p2",
            },
            { value: [{ contactid: "3" }] },
        ]);
        expect(await countContacts({}, { request, ceiling: 5000 })).toBe(3);
    });

    test("a resolved owner always appears in the count filter", async () => {
        const { request, endpoints } = fakeRequest([{ "@odata.count": 0, value: [] }]);
        await countContacts({ ownerId: "owner-7" }, { request });
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-7'");
    });
});

describe("fetchContactsPage", () => {
    test("builds a single page request with a page-size header and returns the raw page", async () => {
        const { request, endpoints } = fakeRequest([
            {
                value: [{ contactid: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=p2",
            },
        ]);
        const page = await fetchContactsPage(
            { clientType: [4] },
            { select: "contactid", pageSize: 50, request }
        );
        expect(page.value).toEqual([{ contactid: "1" }]);
        expect(endpoints[0]).toContain("$select=contactid");
        expect(endpoints[0]).toContain("$orderby=fullname asc");
    });

    test("follows a provided cursor verbatim after normalizing it", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await fetchContactsPage(
            {},
            {
                select: "contactid",
                pageSize: 50,
                cursor:
                    "https://org.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=p2",
                request,
            }
        );
        expect(endpoints[0]).toBe("contacts?$skiptoken=p2");
    });
});
