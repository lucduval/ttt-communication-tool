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
 * The latest-year selection rule: given a contact's rows, return the one with
 * the maximum year. A missing year counts as 0 so a dated row never beats a real
 * one. Returns null for an empty list. The year accessor defaults to ITA34's
 * `riivo_yearofassessment`; pass an accessor for entities that name the year
 * differently (e.g. IRP5's `riivo_assessmentyearint`).
 */
export function pickLatest<T extends Record<string, any>>(
    rows: T[],
    year: (row: T) => number | null | undefined = (row) => row.riivo_yearofassessment
): T | null {
    if (!rows || rows.length === 0) return null;
    return rows.reduce((latest, row) => ((year(row) ?? 0) > (year(latest) ?? 0) ? row : latest));
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

/**
 * Batch read used by the recipient list: fetch ITA34/IRP5 for a page of
 * contacts, select each contact's latest year (the same `pickLatest` rule as
 * the singular read), and map into `TaxProfileData`. Reads are batched ~50 ids
 * per request (OR-joined contact-link filters) rather than looping
 * `fetchTaxProfile` per id. Latest-year selection lives in `pickLatest`, in
 * memory — not in the query — so the list figure matches the preview and the
 * sent email.
 *
 * Returns a map keyed by contactId; every requested id gets an entry (its
 * `ita34`/`irp5` are null when that contact has no rows).
 */
export async function fetchTaxProfiles(contactIds: string[]): Promise<Map<string, TaxProfileData>> {
    const profiles = new Map<string, TaxProfileData>();
    if (!contactIds || contactIds.length === 0) return profiles;

    const ita34ByContact = new Map<string, any[]>();
    const irp5ByContact = new Map<string, any[]>();
    const push = (map: Map<string, any[]>, key: string | undefined, row: any) => {
        if (!key) return;
        const list = map.get(key);
        if (list) list.push(row);
        else map.set(key, [row]);
    };

    for (let i = 0; i < contactIds.length; i += 50) {
        const batch = contactIds.slice(i, i + 50);
        const ita34Filter = batch.map((id) => `_riivo_taxpayercontact_value eq '${id}'`).join(" or ");
        const irp5Filter = batch.map((id) => `_riivo_client_value eq '${id}'`).join(" or ");

        const [ita34Res, irp5Res] = await Promise.all([
            dynamicsRequest<{ value: any[] }>(
                `riivo_ita34s?$select=${ITA34_SELECT},_riivo_taxpayercontact_value&$filter=${ita34Filter}`
            ),
            dynamicsRequest<{ value: any[] }>(
                `riivo_irp5s?$select=${IRP5_SELECT},_riivo_client_value&$filter=${irp5Filter}`
            ),
        ]);

        for (const row of ita34Res.value ?? []) push(ita34ByContact, row._riivo_taxpayercontact_value, row);
        for (const row of irp5Res.value ?? []) push(irp5ByContact, row._riivo_client_value, row);
    }

    for (const contactId of contactIds) {
        const ita34 = pickLatest(ita34ByContact.get(contactId) ?? []);
        const irp5 = pickLatest(irp5ByContact.get(contactId) ?? [], (row) => row.riivo_assessmentyearint);
        profiles.set(contactId, mapTaxProfile(contactId, ita34, irp5));
    }

    return profiles;
}
