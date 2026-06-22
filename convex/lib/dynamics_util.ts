
import { streamContacts, type ContactFilter } from "./contactQuery";
import { resolveSpecialisedAudience, ita34IncomeScanAdapter, taxReturnScanAdapter } from "./specialisedAudience";
import { dynamicsRequest } from "./dynamics_auth";

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
    // Marketing-consent type (typed dimension owned by Contact Query). "all" has
    // no typed representation — it is simply absent.
    marketingType?: "tax" | "accounting" | "insurance";
    // Opt-in flags (typed tri-state dimensions owned by Contact Query). "unset"
    // (UI "all") has no typed representation — it is simply absent.
    whatsappOptIn?: boolean;
    emailEnabled?: boolean;
    // Channel reachability (typed dimension owned by Contact Query). On the send
    // path this is injected from the campaign's channel in processCampaignFilters,
    // not persisted in the stored filters.
    reachableChannel?: "email" | "whatsapp";
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
    // Uploaded audience: restrict the send to exactly this set of contact ids. A
    // filtered selection carrying these re-resolves through Contact Query's
    // `contactIds` streaming dimension at send time, so the campaign behaves like
    // any other filtered campaign (fresh CRM data, owner scoping, channel
    // reachability all enforced server-side).
    contactIds?: string[];
}

/**
 * Adapt the campaign-shaped filter object to the Contact Query module's typed
 * ContactFilter. clientType and sourceCode (each a scalar or array, possibly
 * stringy after a JSON round-trip) are normalised to numeric option-code arrays
 * so the module owns the OData multi-select containment encoding.
 */
export function toContactFilter(filters: CampaignFilters): ContactFilter {
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
        marketingType: filters.marketingType,
        whatsappOptIn: filters.whatsappOptIn,
        emailEnabled: filters.emailEnabled,
        reachableChannel: filters.reachableChannel,
        nameRangeStart: filters.nameRangeStart,
        nameRangeEnd: filters.nameRangeEnd,
        contactIds: filters.contactIds,
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
 * Dynamics contact fields a WhatsApp template variable may be mapped to. Mirrors
 * DYNAMICS_FIELDS in src/components/whatsapp/TemplateForm.tsx. Used as an
 * allowlist so a template's variableMappings can only pull whitelisted fields
 * into the OData $select — guards against invalid or injected field names.
 * `lookup: true` marks entity references whose human-readable value lives in the
 * formatted-value annotation rather than the raw `_field_value` column.
 */
export const MAPPABLE_CONTACT_FIELDS: Record<string, { lookup?: boolean }> = {
    fullname: {},
    firstname: {},
    lastname: {},
    mobilephone: {},
    emailaddress1: {},
    accountnumber: {},
    address1_composite: {},
    address1_city: {},
    riivo_referralcode: {},
    parentcustomerid: { lookup: true },
};

const FORMATTED_VALUE = "@OData.Community.Display.V1.FormattedValue";

/**
 * Batch-fetch specific contact fields by contactid. Returns a map of
 * contactid -> { field: value } covering every requested (allowlisted) field.
 * Contact ids with no matching Dynamics record (e.g. leads/employees, deleted
 * contacts) simply don't appear in the map — callers fall back per recipient.
 */
export async function fetchContactFieldsByIds(
    contactIds: string[],
    fields: string[]
): Promise<Map<string, Record<string, string>>> {
    const result = new Map<string, Record<string, string>>();
    const safeFields = [...new Set(fields)].filter((f) => f in MAPPABLE_CONTACT_FIELDS);
    if (contactIds.length === 0 || safeFields.length === 0) return result;

    const selectParts = new Set<string>(["contactid"]);
    for (const f of safeFields) {
        selectParts.add(MAPPABLE_CONTACT_FIELDS[f].lookup ? `_${f}_value` : f);
    }
    const select = [...selectParts].join(",");

    // 200 ids per request keeps the `contactid eq '..' or ..` $filter well under
    // Dynamics' URL length cap even alongside the $select.
    const CHUNK = 200;
    for (let i = 0; i < contactIds.length; i += CHUNK) {
        const batch = contactIds.slice(i, i + CHUNK);
        const idFilter = batch.map((id) => `contactid eq '${id}'`).join(" or ");
        const endpoint = `contacts?$select=${select}&$filter=${idFilter}`;
        const resp = await dynamicsRequest<{ value: Record<string, unknown>[] }>(endpoint);
        for (const row of resp.value ?? []) {
            const id = row.contactid as string | undefined;
            if (!id) continue;
            const rec: Record<string, string> = {};
            for (const f of safeFields) {
                const raw = MAPPABLE_CONTACT_FIELDS[f].lookup
                    ? row[`_${f}_value${FORMATTED_VALUE}`]
                    : row[f];
                rec[f] = raw == null ? "" : String(raw);
            }
            result.set(id, rec);
        }
    }
    return result;
}

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
