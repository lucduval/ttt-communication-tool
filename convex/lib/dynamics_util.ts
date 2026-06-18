
import { streamContacts, type ContactFilter } from "./contactQuery";
import { resolveSpecialisedAudience, ita34IncomeScanAdapter, taxReturnScanAdapter } from "./specialisedAudience";

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
    clientType?: number | string | Array<number | string>;  // MultiSelect option codes; legacy values may be a scalar
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
 * ContactFilter. clientType and sourceCode (each a scalar or array, possibly
 * stringy after a JSON round-trip) are normalised to numeric option-code arrays
 * so the module owns the OData multi-select containment encoding.
 */
function toContactFilter(filters: CampaignFilters): ContactFilter {
    const { sourceCode, clientType } = filters;

    let sourceCodeArr: number[] | undefined;
    if (sourceCode && (Array.isArray(sourceCode) ? sourceCode.length > 0 : true)) {
        sourceCodeArr = (Array.isArray(sourceCode) ? sourceCode : [sourceCode]).map(Number);
    }

    let clientTypeArr: number[] | undefined;
    if (clientType !== undefined && clientType !== null && (Array.isArray(clientType) ? clientType.length > 0 : true)) {
        clientTypeArr = (Array.isArray(clientType) ? clientType : [clientType]).map(Number);
    }

    return {
        filter: filters.filter,
        search: filters.search,
        clientType: clientTypeArr,
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
    // Stream the send-time audience through the Contact Query module so it shares
    // one filter definition with the recipient list, count, and select-all, and
    // so pagination cursors and retry/backoff are handled in one place.
    const selectFields = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber,riivo_referralcode";

    await streamContacts<SimpleContact>(toContactFilter(filters), {
        select: selectFields,
        onPage: async (rows) => {
            const chunk = rows.map((contact) => ({
                id: contact.contactid,
                fullName: contact.fullname || "",
                email: contact.emailaddress1,
                phone: contact.mobilephone,
                internationalPhone: (contact as any).icon_formattedmobilenumber || null,
                referralCode: contact.riivo_referralcode || null,
            }));
            await onChunk(chunk);
        },
    });
}

const CONTACT_SELECT_SIMPLE = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber,riivo_referralcode";

/**
 * Fetch contacts by tax return (SARS reimbursement) filter, then stream in chunks.
 * Used when taxReturnMin is set in campaign filters.
 *
 * The scan (highest reimbursement per contact in the year window) and the
 * id-chunked re-query now live in the Specialised Audience module / Contact
 * Query; this is the slim send-shape mapper around the shared resolver. The send
 * path displays no figure, so `withTaxProfile` stays unset and the reimbursement
 * scan figure is not read here.
 */
export async function fetchMatchingContactsByTaxReturn(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
    const targetYear = filters.taxReturnYear ?? (new Date().getFullYear() - 1);
    await resolveSpecialisedAudience<SimpleContact>({
        adapter: taxReturnScanAdapter({
            taxReturnMin: filters.taxReturnMin ?? 0,
            targetYear,
        }),
        filter: toContactFilter(filters),
        select: CONTACT_SELECT_SIMPLE,
        onChunk: async (resolved) => {
            await onChunk(
                resolved.map(({ contact: c }) => ({
                    id: c.contactid,
                    fullName: c.fullname || "",
                    email: c.emailaddress1,
                    phone: c.mobilephone,
                    internationalPhone: (c as any).icon_formattedmobilenumber || null,
                    referralCode: c.riivo_referralcode || null,
                }))
            );
        },
    });
}

/**
 * Fetch contacts by ITA34 (income/retirement) filter, then stream in chunks.
 * Used when incomeMin, incomeMax, retirementFundMin, or retirementFundMax is set.
 *
 * Both the membership rule (income range on each contact's latest year) and the
 * id-chunked re-query live in the Specialised Audience module / Contact Query;
 * this is now just the slim send-shape mapper around the shared resolver. The
 * send path displays no income figure, so the Tax Profile join is skipped.
 */
export async function fetchMatchingContactsWithITA34(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
    await resolveSpecialisedAudience<SimpleContact>({
        adapter: ita34IncomeScanAdapter({
            incomeMin: filters.incomeMin,
            incomeMax: filters.incomeMax,
            retirementFundMin: filters.retirementFundMin,
            retirementFundMax: filters.retirementFundMax,
            taxYear: filters.taxReturnYear,
        }),
        filter: toContactFilter(filters),
        select: CONTACT_SELECT_SIMPLE,
        onChunk: async (resolved) => {
            await onChunk(
                resolved.map(({ contact: c }) => ({
                    id: c.contactid,
                    fullName: c.fullname || "",
                    email: c.emailaddress1,
                    phone: c.mobilephone,
                    internationalPhone: (c as any).icon_formattedmobilenumber || null,
                    referralCode: c.riivo_referralcode || null,
                }))
            );
        },
    });
}
