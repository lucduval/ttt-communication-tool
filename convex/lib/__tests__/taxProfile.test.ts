/**
 * Unit tests for the Tax Profile module (issue #23).
 *
 * The module owns a single client's canonical tax figures: the ITA34/IRP5
 * entity read, the latest-year selection rule (`pickLatest`), and the field
 * mapping into `TaxProfileData` (`mapTaxProfile`). The pure functions are the
 * test surface — they are the mapping that was previously copied verbatim
 * across the preview and send paths.
 */
import { describe, it, expect } from "vitest";
import { pickLatest, mapTaxProfile } from "../taxProfile";

describe("pickLatest", () => {
    it("returns the row with the maximum year of assessment", () => {
        const rows = [
            { riivo_yearofassessment: 2021, riivo_income: 100 },
            { riivo_yearofassessment: 2023, riivo_income: 300 },
            { riivo_yearofassessment: 2022, riivo_income: 200 },
        ];
        expect(pickLatest(rows)).toEqual({ riivo_yearofassessment: 2023, riivo_income: 300 });
    });

    it("returns the single row when there is only one", () => {
        const rows = [{ riivo_yearofassessment: 2020, riivo_income: 50 }];
        expect(pickLatest(rows)).toEqual({ riivo_yearofassessment: 2020, riivo_income: 50 });
    });

    it("returns null for an empty list", () => {
        expect(pickLatest([])).toBeNull();
    });

    it("treats a missing year as 0 so a dated row never beats a real one", () => {
        const rows = [
            { riivo_income: 10 },
            { riivo_yearofassessment: 2019, riivo_income: 20 },
        ];
        expect(pickLatest(rows)).toEqual({ riivo_yearofassessment: 2019, riivo_income: 20 });
    });
});

describe("mapTaxProfile", () => {
    const rawIta34 = {
        riivo_yearofassessment: 2024,
        riivo_income: 500000,
        riivo_taxableincomeassessedloss: 450000,
        riivo_retirementannuityfundcontributions: 30000,
        riivo_retirementfundcontributions: 12000,
        riivo_providendfundcontributions: 6000,
        riivo_medicalschemefeestaxcredit: 4000,
        riivo_medicalrebatebelow65withnodisability: 2000,
        riivo_dateofassessment: "2024-07-01",
        riivo_referencenumber: "REF123",
    };
    const rawIrp5 = {
        riivo_assessmentyearint: 2024,
        riivo_incomepaye: 480000,
        riivo_grosstaxableincome: 460000,
        riivo_totaldeductionscontributions: 20000,
        riivo_racontributions: 30000,
        riivo_providentfundcontributionpaye: 6000,
        riivo_totalprovidentfundcontributions: 7000,
        riivo_medicalaidcontributions: 8000,
        riivo_medicalschemetaxcredit: 4000,
        riivo_taxabletravelremuneration: 1000,
        riivo_employertradingothername: "Acme Pty Ltd",
        riivo_taxperiodstartdate: "2023-03-01",
        riivo_taxperiodenddate: "2024-02-28",
    };

    it("maps full ITA34 and IRP5 rows into TaxProfileData", () => {
        const result = mapTaxProfile("contact-1", rawIta34, rawIrp5);
        expect(result).toEqual({
            contactId: "contact-1",
            ita34: {
                yearOfAssessment: 2024,
                income: 500000,
                taxableIncome: 450000,
                raContributions: 30000,
                retirementFundContributions: 12000,
                providentFundContributions: 6000,
                medicalSchemeTaxCredit: 4000,
                medicalRebate: 2000,
                dateOfAssessment: "2024-07-01",
                referenceNumber: "REF123",
            },
            irp5: {
                assessmentYear: 2024,
                incomePaye: 480000,
                grossTaxableIncome: 460000,
                totalDeductions: 20000,
                raContributions: 30000,
                providentFundContribution: 6000,
                totalProvidentFund: 7000,
                medicalAidContributions: 8000,
                medicalSchemeTaxCredit: 4000,
                taxableTravel: 1000,
                employerName: "Acme Pty Ltd",
                taxPeriodStart: "2023-03-01",
                taxPeriodEnd: "2024-02-28",
            },
        });
    });

    it("returns null sub-objects when the rows are null", () => {
        expect(mapTaxProfile("contact-2", null, null)).toEqual({
            contactId: "contact-2",
            ita34: null,
            irp5: null,
        });
    });

    it("defaults missing numeric fields to 0 and missing string fields to null", () => {
        const result = mapTaxProfile("contact-3", {}, {});
        expect(result.ita34).toEqual({
            yearOfAssessment: 0,
            income: 0,
            taxableIncome: 0,
            raContributions: 0,
            retirementFundContributions: 0,
            providentFundContributions: 0,
            medicalSchemeTaxCredit: 0,
            medicalRebate: 0,
            dateOfAssessment: null,
            referenceNumber: null,
        });
        expect(result.irp5).toEqual({
            assessmentYear: 0,
            incomePaye: 0,
            grossTaxableIncome: 0,
            totalDeductions: 0,
            raContributions: null,
            providentFundContribution: 0,
            totalProvidentFund: 0,
            medicalAidContributions: 0,
            medicalSchemeTaxCredit: 0,
            taxableTravel: 0,
            employerName: null,
            taxPeriodStart: null,
            taxPeriodEnd: null,
        });
    });
});
