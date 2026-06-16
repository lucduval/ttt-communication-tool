
import { dynamicsRequest } from "../actions/dynamics";
import { buildContactFilter, buildContactFilterClauses, type ContactFilter } from "./contactQuery";

interface SimpleContact {
    contactid: string;
    fullname: string | null;
    emailaddress1: string | null;
    mobilephone: string | null;
    riivo_referralcode: string | null;
}

export interface ShimmedContact {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    internationalPhone: string | null;
    referralCode: string | null;
}

export interface CampaignFilters {
    filter?: string;
    search?: string;
    clientType?: number | string;  // OptionSet: number from API, string from JSON
    entityType?: number;
    bank?: number;
    sourceCode?: string | string[];
    province?: string;
    geographicLocation?: number; // SA Provinces option set (riivo_geographiclocation)
    ageMin?: number;
    ageMax?: number;
    ownerId?: string;
    industryId?: string;
    // Tax return filters (filters on new_invoiceses entity)
    taxReturnMin?: number;  // minimum ttt_sarsreimbursement
    taxReturnYear?: number; // filter invoices by year (createdon), defaults to previous year
    // ITA34 / income filters
    incomeMin?: number;
    incomeMax?: number;
    retirementFundMin?: number;
    retirementFundMax?: number;
    // Alphabetical name range for batch sending
    nameRangeStart?: string; // e.g. "A"
    nameRangeEnd?: string;   // e.g. "F"
    // Contact IDs explicitly excluded by the user (individual unchecks during select-all)
    excludeContactIds?: string[];
}

/**
 * Adapt the campaign-shaped filter object to the Contact Query module's typed
 * ContactFilter. clientType (a number or string from JSON) and sourceCode (a
 * string or string array) are normalised so the module owns the OData encoding.
 */
function toContactFilter(filters: CampaignFilters): ContactFilter {
    const { sourceCode, clientType } = filters;

    let sourceCodeArr: number[] | undefined;
    if (sourceCode && (Array.isArray(sourceCode) ? sourceCode.length > 0 : true)) {
        sourceCodeArr = (Array.isArray(sourceCode) ? sourceCode : [sourceCode]).map(Number);
    }

    return {
        filter: filters.filter,
        search: filters.search,
        clientType: clientType !== undefined && clientType !== null ? String(clientType) : undefined,
        entityType: filters.entityType,
        bank: filters.bank,
        sourceCode: sourceCodeArr,
        province: filters.province,
        geographicLocation: filters.geographicLocation,
        ageMin: filters.ageMin,
        ageMax: filters.ageMax,
        ownerId: filters.ownerId,
        industryId: filters.industryId,
        nameRangeStart: filters.nameRangeStart,
        nameRangeEnd: filters.nameRangeEnd,
    };
}

/**
 * Fetch contacts matching filters from Dynamics and process them in chunks
 */
export async function fetchMatchingContacts(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
    // Build the contact-level filter via the Contact Query module so the
    // send-time audience matches the recipient list, count, and select-all.
    const filterExpression = buildContactFilter(toContactFilter(filters));

    console.log(`[fetchMatchingContacts] Filter Expression: ${filterExpression}`);

    const selectFields = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber,riivo_referralcode";
    const initialEndpoint = `contacts?$filter=${filterExpression}&$select=${selectFields}&$orderby=fullname asc`;

    interface SimpleContactsResponse {
        "@odata.context": string;
        "@odata.nextLink"?: string;
        value: SimpleContact[];
    }

    let nextLink: string | null = initialEndpoint;
    let pageCount = 0;
    const MAX_PAGES = 1000; // 50k contacts limit safe guard
    const MAX_PAGE_RETRIES = 3;

    while (nextLink && pageCount < MAX_PAGES) {
        pageCount++;
        const currentLink: string = nextLink;
        if (currentLink.startsWith("http")) {
            nextLink = currentLink.replace(/^.*\/api\/data\/v9\.2\//, "");
        } else {
            nextLink = currentLink;
        }

        if (!nextLink) break;

        let pageSuccess = false;
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
            try {
                const response: SimpleContactsResponse = await dynamicsRequest<SimpleContactsResponse>(nextLink!);

                if (response.value && response.value.length > 0) {
                    const chunk = response.value.map((contact) => ({
                        id: contact.contactid,
                        fullName: contact.fullname || "",
                        email: contact.emailaddress1,
                        phone: contact.mobilephone,
                        internationalPhone: (contact as any).icon_formattedmobilenumber || null,
                        referralCode: contact.riivo_referralcode || null,
                    }));

                    await onChunk(chunk);
                }

                nextLink = response["@odata.nextLink"] || null;
                pageSuccess = true;
                break;
            } catch (error) {
                lastError = error;
                console.warn(`Error fetching contacts page ${pageCount} (attempt ${attempt}/${MAX_PAGE_RETRIES}):`, error);
                if (attempt < MAX_PAGE_RETRIES) {
                    // Exponential backoff: 1s, 2s, 4s
                    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
                }
            }
        }

        if (!pageSuccess) {
            console.error(`Failed to fetch contacts page ${pageCount} after ${MAX_PAGE_RETRIES} attempts. Aborting.`, lastError);
            throw lastError;
        }
    }
}

/**
 * Build extra contact-level filter from CampaignFilters (shared by tax return and ITA34 fetches).
 *
 * Delegates to the Contact Query module's clause builder so the two-step audience
 * sends apply exactly the same contact-level filtering as a standard query — they
 * append these clauses to their own contact-id-batch base.
 */
function buildExtraContactFilter(filters: CampaignFilters): string {
    return buildContactFilterClauses(toContactFilter(filters));
}

const CONTACT_SELECT_SIMPLE = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber,riivo_referralcode";

/**
 * Fetch contacts by tax return (SARS reimbursement) filter, then stream in chunks.
 * Used when taxReturnMin is set in campaign filters.
 */
export async function fetchMatchingContactsByTaxReturn(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
    const { taxReturnMin = 0, taxReturnYear } = filters;
    const targetYear = taxReturnYear ?? (new Date().getFullYear() - 1);
    const yearStart = `${targetYear}-01-01T00:00:00Z`;
    const yearEnd = `${targetYear + 1}-01-01T00:00:00Z`;

    const invoiceFilter = `ttt_sarsreimbursement ge ${taxReturnMin} and createdon ge ${yearStart} and createdon lt ${yearEnd} and _ttt_customer_value ne null and statecode eq 1`;
    const invoiceEndpoint = `new_invoiceses?$select=_ttt_customer_value,ttt_sarsreimbursement,createdon&$filter=${invoiceFilter}&$orderby=ttt_sarsreimbursement desc`;

    interface InvoiceRow { _ttt_customer_value: string; ttt_sarsreimbursement: number | null; createdon: string }
    let allInvoices: InvoiceRow[] = [];
    let nextLink: string | null = invoiceEndpoint;
    let pageCount = 0;

    while (nextLink && pageCount < 100) {
        pageCount++;
        const endpoint: string = nextLink.startsWith("http") ? nextLink.replace(/^.*\/api\/data\/v9\.2\//, "") : nextLink;
        const response = await dynamicsRequest<{ value: InvoiceRow[]; "@odata.nextLink"?: string }>(endpoint);
        if (response.value?.length) allInvoices.push(...response.value);
        nextLink = response["@odata.nextLink"] ?? null;
    }

    const contactMap = new Map<string, InvoiceRow>();
    for (const row of allInvoices) {
        const cid = row._ttt_customer_value;
        if (!cid) continue;
        const existing = contactMap.get(cid);
        if (!existing || (row.ttt_sarsreimbursement ?? 0) > (existing.ttt_sarsreimbursement ?? 0)) contactMap.set(cid, row);
    }
    const contactIds = Array.from(contactMap.keys());
    if (contactIds.length === 0) return;

    const extraFilter = buildExtraContactFilter(filters);
    for (let i = 0; i < contactIds.length; i += 500) {
        const batch = contactIds.slice(i, i + 500);
        const idFilter = batch.map((id) => `contactid eq '${id}'`).join(" or ");
        const contactEndpoint = `contacts?$select=${CONTACT_SELECT_SIMPLE}&$filter=statecode eq 0 and (${idFilter})${extraFilter}&$orderby=fullname asc`;
        const contactResponse = await dynamicsRequest<{ value: SimpleContact[] }>(contactEndpoint);
        if (contactResponse.value?.length) {
            const chunk = contactResponse.value.map((c) => ({
                id: c.contactid,
                fullName: c.fullname || "",
                email: c.emailaddress1,
                phone: c.mobilephone,
                internationalPhone: (c as any).icon_formattedmobilenumber || null,
                referralCode: c.riivo_referralcode || null,
            }));
            await onChunk(chunk);
        }
    }
}

/**
 * Fetch contacts by ITA34 (income/retirement) filter, then stream in chunks.
 * Used when incomeMin, incomeMax, retirementFundMin, or retirementFundMax is set.
 */
export async function fetchMatchingContactsWithITA34(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
    let ita34Filter = "statecode eq 0 and _riivo_taxpayercontact_value ne null";
    const { taxReturnYear: taxYear, incomeMin, incomeMax, retirementFundMin, retirementFundMax } = filters;
    if (taxYear) ita34Filter += ` and riivo_yearofassessment eq ${taxYear}`;
    if (incomeMin !== undefined) ita34Filter += ` and riivo_income ge ${incomeMin}`;
    if (incomeMax !== undefined) ita34Filter += ` and riivo_income le ${incomeMax}`;
    if (retirementFundMin !== undefined) ita34Filter += ` and riivo_retirementfundcontributions ge ${retirementFundMin}`;
    if (retirementFundMax !== undefined) ita34Filter += ` and riivo_retirementfundcontributions le ${retirementFundMax}`;

    const ita34Endpoint = `riivo_ita34s?$select=_riivo_taxpayercontact_value,riivo_income,riivo_retirementfundcontributions,riivo_yearofassessment&$filter=${ita34Filter}&$orderby=riivo_yearofassessment desc`;

    interface ITA34Row { _riivo_taxpayercontact_value: string; riivo_yearofassessment: number | null }
    let allIta34s: ITA34Row[] = [];
    let nextLink: string | null = ita34Endpoint;
    let pageCount = 0;

    while (nextLink && pageCount < 100) {
        pageCount++;
        const endpoint: string = nextLink.startsWith("http") ? nextLink.replace(/^.*\/api\/data\/v9\.2\//, "") : nextLink;
        const response = await dynamicsRequest<{ value: ITA34Row[]; "@odata.nextLink"?: string }>(endpoint);
        if (response.value?.length) allIta34s.push(...response.value);
        nextLink = response["@odata.nextLink"] ?? null;
    }

    const contactMap = new Map<string, ITA34Row>();
    for (const row of allIta34s) {
        const cid = row._riivo_taxpayercontact_value;
        if (!cid) continue;
        const existing = contactMap.get(cid);
        if (!existing || (row.riivo_yearofassessment ?? 0) > (existing.riivo_yearofassessment ?? 0)) contactMap.set(cid, row);
    }
    const contactIds = Array.from(contactMap.keys());
    if (contactIds.length === 0) return;

    const extraFilter = buildExtraContactFilter(filters);
    for (let i = 0; i < contactIds.length; i += 500) {
        const batch = contactIds.slice(i, i + 500);
        const idFilter = batch.map((id) => `contactid eq '${id}'`).join(" or ");
        const contactEndpoint = `contacts?$select=${CONTACT_SELECT_SIMPLE}&$filter=statecode eq 0 and (${idFilter})${extraFilter}&$orderby=fullname asc`;
        const contactResponse = await dynamicsRequest<{ value: SimpleContact[] }>(contactEndpoint);
        if (contactResponse.value?.length) {
            const chunk = contactResponse.value.map((c) => ({
                id: c.contactid,
                fullName: c.fullname || "",
                email: c.emailaddress1,
                phone: c.mobilephone,
                internationalPhone: (c as any).icon_formattedmobilenumber || null,
                referralCode: c.riivo_referralcode || null,
            }));
            await onChunk(chunk);
        }
    }
}
