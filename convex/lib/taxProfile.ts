/**
 * Tax Profile module
 *
 * The single deep place that owns a *single client's canonical tax figures*:
 * given a contact id, the ITA34/IRP5 figures for that client's **latest year of
 * assessment**, mapped into the `TaxProfileData` shape. One module owns three
 * things that were previously copied verbatim across the preview and send
 * paths:
 *
 *   - the ITA34/IRP5 entity read (`fetchTaxProfile`),
 *   - the latest-year selection rule (`pickLatest`), and
 *   - the field mapping into `TaxProfileData` (`mapTaxProfile`).
 *
 * Because every reader resolves figures through here, the figure shown in the
 * recipient list, the figure in the personalised preview, and the figure in the
 * sent email are the same value. "Income" displayed to advisors means **taxable
 * income** (`riivo_taxableincomeassessedloss`) everywhere.
 */

import { dynamicsRequest } from "./dynamics_auth";

export interface TaxProfileData {
    contactId: string;
    ita34: {
        yearOfAssessment: number;
        income: number;
        taxableIncome: number;
        raContributions: number;
        retirementFundContributions: number;
        providentFundContributions: number;
        medicalSchemeTaxCredit: number;
        medicalRebate: number;
        dateOfAssessment: string | null;
        referenceNumber: string | null;
    } | null;
    irp5: {
        assessmentYear: number;
        incomePaye: number;
        grossTaxableIncome: number;
        totalDeductions: number;
        raContributions: number | null;
        providentFundContribution: number;
        totalProvidentFund: number;
        medicalAidContributions: number;
        medicalSchemeTaxCredit: number;
        taxableTravel: number;
        employerName: string | null;
        taxPeriodStart: string | null;
        taxPeriodEnd: string | null;
    } | null;
}

export const ITA34_SELECT = [
    "riivo_ita34id", "riivo_yearofassessment", "riivo_income",
    "riivo_taxableincomeassessedloss", "riivo_retirementannuityfundcontributions",
    "riivo_retirementfundcontributions", "riivo_providendfundcontributions",
    "riivo_medicalschemefeestaxcredit", "riivo_medicalrebatebelow65withnodisability",
    "riivo_dateofassessment", "riivo_referencenumber",
].join(",");

export const IRP5_SELECT = [
    "riivo_irp5id", "riivo_assessmentyearint", "riivo_incomepaye",
    "riivo_grosstaxableincome", "riivo_totaldeductionscontributions",
    "riivo_racontributions", "riivo_providentfundcontributionpaye",
    "riivo_totalprovidentfundcontributions", "riivo_medicalaidcontributions",
    "riivo_medicalschemetaxcredit", "riivo_taxabletravelremuneration",
    "riivo_employertradingothername", "riivo_taxperiodstartdate", "riivo_taxperiodenddate",
].join(",");

/**
 * The latest-year selection rule: given a contact's ITA34 rows, return the one
 * with the maximum year of assessment. A missing year counts as 0 so a dated
 * row never beats a real one. Returns null for an empty list.
 */
export function pickLatest<T extends { riivo_yearofassessment?: number | null }>(
    rows: T[]
): T | null {
    if (!rows || rows.length === 0) return null;
    return rows.reduce((latest, row) =>
        (row.riivo_yearofassessment ?? 0) > (latest.riivo_yearofassessment ?? 0) ? row : latest
    );
}

/**
 * The field mapping: raw Dynamics ITA34/IRP5 rows → `TaxProfileData`. Missing
 * numeric fields default to 0, missing string fields to null. A null row maps
 * to a null sub-object.
 */
export function mapTaxProfile(
    contactId: string,
    rawIta34: Record<string, any> | null,
    rawIrp5: Record<string, any> | null
): TaxProfileData {
    return {
        contactId,
        ita34: rawIta34 ? {
            yearOfAssessment: rawIta34.riivo_yearofassessment ?? 0,
            income: rawIta34.riivo_income ?? 0,
            taxableIncome: rawIta34.riivo_taxableincomeassessedloss ?? 0,
            raContributions: rawIta34.riivo_retirementannuityfundcontributions ?? 0,
            retirementFundContributions: rawIta34.riivo_retirementfundcontributions ?? 0,
            providentFundContributions: rawIta34.riivo_providendfundcontributions ?? 0,
            medicalSchemeTaxCredit: rawIta34.riivo_medicalschemefeestaxcredit ?? 0,
            medicalRebate: rawIta34.riivo_medicalrebatebelow65withnodisability ?? 0,
            dateOfAssessment: rawIta34.riivo_dateofassessment ?? null,
            referenceNumber: rawIta34.riivo_referencenumber ?? null,
        } : null,
        irp5: rawIrp5 ? {
            assessmentYear: rawIrp5.riivo_assessmentyearint ?? 0,
            incomePaye: rawIrp5.riivo_incomepaye ?? 0,
            grossTaxableIncome: rawIrp5.riivo_grosstaxableincome ?? 0,
            totalDeductions: rawIrp5.riivo_totaldeductionscontributions ?? 0,
            raContributions: rawIrp5.riivo_racontributions ?? null,
            providentFundContribution: rawIrp5.riivo_providentfundcontributionpaye ?? 0,
            totalProvidentFund: rawIrp5.riivo_totalprovidentfundcontributions ?? 0,
            medicalAidContributions: rawIrp5.riivo_medicalaidcontributions ?? 0,
            medicalSchemeTaxCredit: rawIrp5.riivo_medicalschemetaxcredit ?? 0,
            taxableTravel: rawIrp5.riivo_taxabletravelremuneration ?? 0,
            employerName: rawIrp5.riivo_employertradingothername ?? null,
            taxPeriodStart: rawIrp5.riivo_taxperiodstartdate ?? null,
            taxPeriodEnd: rawIrp5.riivo_taxperiodenddate ?? null,
        } : null,
    };
}

/**
 * Singular read used by per-contact callers (preview, send): fetch a contact's
 * ITA34/IRP5 rows, select the latest year, and map into `TaxProfileData`. The
 * latest-year rule lives in `pickLatest`, not in the query, so the module owns
 * the selection.
 */
export async function fetchTaxProfile(contactId: string): Promise<TaxProfileData> {
    const [ita34Res, irp5Res] = await Promise.all([
        dynamicsRequest<{ value: any[] }>(
            `riivo_ita34s?$select=${ITA34_SELECT}&$filter=_riivo_taxpayercontact_value eq '${contactId}'&$orderby=riivo_yearofassessment desc`
        ),
        dynamicsRequest<{ value: any[] }>(
            `riivo_irp5s?$select=${IRP5_SELECT}&$filter=_riivo_client_value eq '${contactId}'&$orderby=riivo_assessmentyearint desc&$top=1`
        ),
    ]);

    const ita34 = pickLatest(ita34Res.value);
    const irp5 = irp5Res.value[0] || null;

    return mapTaxProfile(contactId, ita34, irp5);
}
