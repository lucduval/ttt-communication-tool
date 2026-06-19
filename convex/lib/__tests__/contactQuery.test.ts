import { describe, test, expect } from "vitest";
import {
    buildContactFilter,
    buildContactFilterClauses,
    buildContactIdClause,
    escapeODataValue,
    normalizeEndpoint,
    streamPages,
    streamContacts,
    countContacts,
    fetchContactsPage,
    streamEntity,
    countEntity,
    fetchEntityPage,
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

    test("ignores a raw passthrough filter — the OData escape hatch is removed", () => {
        // The raw `filter` dimension no longer exists: every contact-level concept
        // is a typed dimension, so a stray raw string (e.g. from a stale payload)
        // contributes nothing rather than being concatenated into the query.
        expect(buildContactFilter({ filter: "riivo_taxmarketing eq true" } as ContactFilter)).toBe(
            "statecode eq 0"
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

    test("a name-range start only emits just the lower bound", () => {
        expect(buildContactFilter({ nameRangeStart: "A" })).toBe(
            "statecode eq 0 and fullname ge 'A'"
        );
    });

    test("a name-range end only emits just the next-letter upper bound", () => {
        expect(buildContactFilter({ nameRangeEnd: "F" })).toBe(
            "statecode eq 0 and fullname lt 'G'"
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

    test("marketing type 'tax' emits the tax-marketing equality clause", () => {
        expect(buildContactFilter({ marketingType: "tax" })).toBe(
            "statecode eq 0 and riivo_taxmarketing eq true"
        );
    });

    test("marketing type 'accounting' emits the accounting-marketing equality clause", () => {
        expect(buildContactFilter({ marketingType: "accounting" })).toBe(
            "statecode eq 0 and riivo_accountingmarketing eq true"
        );
    });

    test("marketing type 'insurance' emits the insurance-marketing equality clause", () => {
        expect(buildContactFilter({ marketingType: "insurance" })).toBe(
            "statecode eq 0 and riivo_insurancemarketing eq true"
        );
    });

    test("an absent marketing type (the 'all' case) contributes no clause", () => {
        expect(buildContactFilter({ marketingType: undefined })).toBe("statecode eq 0");
    });

    test("WhatsApp opt-in true emits the whatsapp-optin true equality clause", () => {
        expect(buildContactFilter({ whatsappOptIn: true })).toBe(
            "statecode eq 0 and riivo_whatsappoptinout eq true"
        );
    });

    test("WhatsApp opt-in false emits the whatsapp-optin false equality clause", () => {
        expect(buildContactFilter({ whatsappOptIn: false })).toBe(
            "statecode eq 0 and riivo_whatsappoptinout eq false"
        );
    });

    test("an unset WhatsApp opt-in contributes no clause", () => {
        expect(buildContactFilter({ whatsappOptIn: undefined })).toBe("statecode eq 0");
    });

    test("email-enabled true emits the send-email-notifications true equality clause", () => {
        expect(buildContactFilter({ emailEnabled: true })).toBe(
            "statecode eq 0 and icon_sendemailclientnotifications eq true"
        );
    });

    test("email-enabled false emits the send-email-notifications false equality clause", () => {
        expect(buildContactFilter({ emailEnabled: false })).toBe(
            "statecode eq 0 and icon_sendemailclientnotifications eq false"
        );
    });

    test("an unset email-enabled contributes no clause", () => {
        expect(buildContactFilter({ emailEnabled: undefined })).toBe("statecode eq 0");
    });

    test("email reachability emits the has-email presence clause", () => {
        expect(buildContactFilter({ reachableChannel: "email" })).toBe(
            "statecode eq 0 and emailaddress1 ne null"
        );
    });

    test("whatsapp reachability emits the phone-presence + opt-in clause", () => {
        expect(buildContactFilter({ reachableChannel: "whatsapp" })).toBe(
            "statecode eq 0 and (mobilephone ne null or icon_formattedmobilenumber ne null) and riivo_whatsappoptinout eq true"
        );
    });

    test("an unset reachable channel contributes no clause", () => {
        expect(buildContactFilter({ reachableChannel: undefined })).toBe("statecode eq 0");
    });

    test("whatsapp reachability composes with the opt-in dimension without double-emitting", () => {
        // The whatsapp reachability clause already carries `riivo_whatsappoptinout
        // eq true`, so the standalone opt-in dimension is suppressed — the field
        // appears exactly once.
        const expr = buildContactFilter({ reachableChannel: "whatsapp", whatsappOptIn: true });
        expect(expr).toBe(
            "statecode eq 0 and (mobilephone ne null or icon_formattedmobilenumber ne null) and riivo_whatsappoptinout eq true"
        );
        expect(expr.match(/riivo_whatsappoptinout/g)).toHaveLength(1);
    });

    test("email reachability does not suppress the standalone opt-in dimension", () => {
        // Only whatsapp reachability owns the opt-in equality; on email reachability
        // the opt-in dimension still emits its own clause.
        expect(buildContactFilter({ reachableChannel: "email", whatsappOptIn: true })).toBe(
            "statecode eq 0 and riivo_whatsappoptinout eq true and emailaddress1 ne null"
        );
    });

    test("characterizes the full clause ordering for a representative spread", () => {
        const filter: ContactFilter = {
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

    test("ignores audience-specific extra fields so specialised audiences can pass their resolvedArgs verbatim", () => {
        // Specialised audience handlers (tax-return / ITA34 / bad-debt /
        // referral-participant) pass their whole resolvedArgs object — which
        // carries audience-only fields like taxReturnMin / taxYear alongside the
        // standard contact filters. The clause builder must emit only the
        // contact-level clauses and silently drop the unknown audience fields.
        const audienceArgs = {
            taxReturnMin: 1000,
            taxReturnYear: 2024,
            taxYear: 2024,
            incomeMin: 50000,
            clientType: [4, 5],
            ownerId: "owner-1",
        } as unknown as ContactFilter;
        expect(buildContactFilterClauses(audienceArgs)).toBe(
            " and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4','5'])" +
                " and _ownerid_value eq 'owner-1'"
        );
    });

    test("contactIds is an execution-level streaming dimension, not a single filter clause", () => {
        // contactIds must never be flattened into one filter expression — it fans
        // out over chunked queries in streamContacts. Both clause builders ignore it.
        expect(buildContactFilter({ contactIds: ["a", "b"] })).toBe("statecode eq 0");
        expect(buildContactFilterClauses({ contactIds: ["a", "b"] })).toBe("");
    });

    test("characterizes the extra-filter clause ordering for a representative spread", () => {
        const filter: ContactFilter = {
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
            marketingType: "tax",
            whatsappOptIn: true,
            emailEnabled: false,
            reachableChannel: "email",
            nameRangeStart: "A",
            nameRangeEnd: "F",
        };
        expect(buildContactFilterClauses(filter)).toBe(
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
                " and riivo_taxmarketing eq true" +
                " and riivo_whatsappoptinout eq true" +
                " and icon_sendemailclientnotifications eq false" +
                " and emailaddress1 ne null" +
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

describe("buildContactIdClause", () => {
    test("ORs one contactid eq clause per id", () => {
        expect(buildContactIdClause(["a", "b", "c"])).toBe(
            "contactid eq 'a' or contactid eq 'b' or contactid eq 'c'"
        );
    });

    test("escapes apostrophes in ids", () => {
        expect(buildContactIdClause(["o'x"])).toBe("contactid eq 'o''x'");
    });
});

describe("streamContacts with contactIds", () => {
    test("a single chunk restricts the filter to the id set alongside the active-only base", async () => {
        const { request, endpoints } = fakeRequest([
            { value: [{ contactid: "a" }, { contactid: "b" }] },
        ]);
        const collected: Array<{ contactid: string }> = [];
        await streamContacts<{ contactid: string }>(
            { contactIds: ["a", "b"] },
            {
                select: "contactid",
                request,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );
        expect(collected.map((c) => c.contactid)).toEqual(["a", "b"]);
        expect(endpoints).toHaveLength(1);
        expect(endpoints[0]).toContain(
            "$filter=statecode eq 0 and (contactid eq 'a' or contactid eq 'b')"
        );
    });

    test("fans out over the OR-ceiling, one query per chunk, streaming every chunk in order", async () => {
        const { request, endpoints } = fakeRequest([
            { value: [{ contactid: "1" }, { contactid: "2" }] },
            { value: [{ contactid: "3" }] },
        ]);
        const collected: Array<{ contactid: string }> = [];
        await streamContacts<{ contactid: string }>(
            { contactIds: ["1", "2", "3"] },
            {
                select: "contactid",
                request,
                contactIdChunkSize: 2,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );
        expect(collected.map((c) => c.contactid)).toEqual(["1", "2", "3"]);
        expect(endpoints).toHaveLength(2);
        expect(endpoints[0]).toContain("contactid eq '1' or contactid eq '2'");
        expect(endpoints[0]).not.toContain("contactid eq '3'");
        expect(endpoints[1]).toContain("contactid eq '3'");
        expect(endpoints[1]).not.toContain("contactid eq '1'");
    });

    test("paginates each chunk independently, following its nextLink", async () => {
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
            { contactIds: ["a"] },
            {
                select: "contactid",
                request,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );
        expect(collected.map((c) => c.contactid)).toEqual(["1", "2"]);
        expect(endpoints[1]).toBe("contacts?$skiptoken=p2");
    });

    test("composes with all other filter clauses on every chunk", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await streamContacts(
            { contactIds: ["x"], ownerId: "owner-1", clientType: [4] },
            { select: "contactid", request, onPage: () => {} }
        );
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-1'");
        expect(endpoints[0]).toContain(
            "Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['4'])"
        );
        expect(endpoints[0]).toContain("contactid eq 'x'");
    });

    test("an empty id set yields nothing and issues no requests", async () => {
        const { request, endpoints } = fakeRequest([
            { value: [{ contactid: "should-not-appear" }] },
        ]);
        const collected: Array<{ contactid: string }> = [];
        await streamContacts<{ contactid: string }>(
            { contactIds: [] },
            {
                select: "contactid",
                request,
                onPage: (rows) => {
                    collected.push(...rows);
                },
            }
        );
        expect(collected).toEqual([]);
        expect(endpoints).toHaveLength(0);
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

// ---- Entity-agnostic execution core ----
//
// The core operations accept a prebuilt filter expression plus the entity,
// select, order, and id-field, so a sibling module (e.g. Lead Query) can drive
// the same paging/retry/count engine without duplicating it. These tests use a
// non-contact entity ("leads") to prove the engine is genuinely entity-agnostic.

describe("streamEntity", () => {
    test("pages through a non-contact entity, normalizing each cursor", async () => {
        const { request, endpoints } = fakeRequest([
            {
                value: [{ leadid: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/leads?$skiptoken=p2",
            },
            { value: [{ leadid: "2" }] },
        ]);

        const collected: Array<{ leadid: string }> = [];
        await streamEntity<{ leadid: string }>("statecode eq 0", {
            entity: "leads",
            select: "leadid",
            orderby: "fullname asc",
            request,
            onPage: (rows) => {
                collected.push(...rows);
            },
        });

        expect(collected.map((c) => c.leadid)).toEqual(["1", "2"]);
        expect(endpoints[0]).toBe(
            "leads?$filter=statecode eq 0&$select=leadid&$orderby=fullname asc"
        );
        expect(endpoints[1]).toBe("leads?$skiptoken=p2");
    });

    test("uses the prebuilt filter expression verbatim", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await streamEntity("statecode eq 0 and _ownerid_value eq 'owner-9'", {
            entity: "leads",
            select: "leadid",
            orderby: "fullname asc",
            request,
            onPage: () => {},
        });
        expect(endpoints[0]).toContain("_ownerid_value eq 'owner-9'");
    });
});

describe("countEntity", () => {
    test("returns the odata count when below the ceiling", async () => {
        const { request, endpoints } = fakeRequest([{ "@odata.count": 7, value: [] }]);
        expect(
            await countEntity("statecode eq 0", {
                entity: "leads",
                idField: "leadid",
                request,
            })
        ).toBe(7);
        expect(endpoints[0]).toBe(
            "leads?$filter=statecode eq 0&$count=true&$top=1&$select=leadid"
        );
    });

    test("paginates ids when the count hits the ceiling", async () => {
        const { request, endpoints } = fakeRequest([
            { "@odata.count": 5000, value: [{ leadid: "probe" }] },
            {
                value: [{ leadid: "1" }, { leadid: "2" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/leads?$skiptoken=p2",
            },
            { value: [{ leadid: "3" }] },
        ]);
        expect(
            await countEntity("statecode eq 0", {
                entity: "leads",
                idField: "leadid",
                ceiling: 5000,
                request,
            })
        ).toBe(3);
        expect(endpoints[1]).toBe(
            "leads?$filter=statecode eq 0&$select=leadid&$count=true"
        );
    });
});

describe("fetchEntityPage", () => {
    test("builds a single page request for a non-contact entity", async () => {
        const { request, endpoints } = fakeRequest([{ value: [{ leadid: "1" }] }]);
        const page = await fetchEntityPage<{ leadid: string }>("statecode eq 0", {
            entity: "leads",
            select: "leadid",
            orderby: "fullname asc",
            pageSize: 50,
            request,
        });
        expect(page.value).toEqual([{ leadid: "1" }]);
        expect(endpoints[0]).toBe(
            "leads?$select=leadid&$filter=statecode eq 0&$orderby=fullname asc"
        );
    });

    test("requests the capped count when countOnly is set", async () => {
        const { request, endpoints } = fakeRequest([{ "@odata.count": 3, value: [] }]);
        await fetchEntityPage("statecode eq 0", {
            entity: "leads",
            select: "leadid",
            orderby: "fullname asc",
            pageSize: 50,
            countOnly: true,
            request,
        });
        expect(endpoints[0]).toBe(
            "leads?$select=leadid&$filter=statecode eq 0&$orderby=fullname asc&$count=true&$top=1"
        );
    });

    test("follows a provided cursor verbatim after normalizing it", async () => {
        const { request, endpoints } = fakeRequest([{ value: [] }]);
        await fetchEntityPage("statecode eq 0", {
            entity: "leads",
            select: "leadid",
            orderby: "fullname asc",
            pageSize: 50,
            cursor:
                "https://org.api.crm.dynamics.com/api/data/v9.2/leads?$skiptoken=p2",
            request,
        });
        expect(endpoints[0]).toBe("leads?$skiptoken=p2");
    });
});

describe("streamPages is exported for sibling-module consumption", () => {
    test("drives raw paging over any endpoint", async () => {
        const { request } = fakeRequest([
            {
                value: [{ id: "1" }],
                "@odata.nextLink":
                    "https://org.api.crm.dynamics.com/api/data/v9.2/leads?$skiptoken=p2",
            },
            { value: [{ id: "2" }] },
        ]);
        const collected: Array<{ id: string }> = [];
        await streamPages<{ id: string }>("leads?$filter=statecode eq 0", {
            request,
            onPage: (rows) => {
                collected.push(...rows);
            },
        });
        expect(collected.map((c) => c.id)).toEqual(["1", "2"]);
    });
});
