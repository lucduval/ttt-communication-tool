import { describe, test, expect } from "vitest";
import {
    buildContactFilter,
    buildContactFilterClauses,
    escapeODataValue,
    type ContactFilter,
} from "../contactQuery";

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

    test("client type is emitted as a quoted equality match", () => {
        expect(buildContactFilter({ clientType: "Gold" })).toBe(
            "statecode eq 0 and riivo_clienttypenew eq 'Gold'"
        );
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
            clientType: "Gold",
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
                " and riivo_clienttypenew eq 'Gold'" +
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
        expect(buildContactFilterClauses({ clientType: "Gold", ageMin: 30 })).toBe(
            " and riivo_clienttypenew eq 'Gold' and riivo_age ge 30"
        );
    });

    test("buildContactFilter is the active-only base concatenated with the clauses", () => {
        const filter: ContactFilter = {
            filter: "riivo_taxmarketing eq true",
            search: "jo'hn",
            clientType: "Gold",
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
            clientType: "Gold",
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
                " and riivo_clienttypenew eq 'Gold'" +
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
