"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { dynamicsRequest } from "../lib/dynamics_auth";
import {
    countContacts,
    fetchContactsPage,
    streamContacts,
} from "../lib/contactQuery";
import {
    countLeads,
    fetchLeadsPage,
    streamLeads,
    type LeadFilter,
} from "../lib/leadQuery";
import { api } from "../_generated/api";
export { dynamicsRequest };

/**
 * Resolves the effective ownerId for a contact query.
 * - Admins: full control (can query any owner or all contacts)
 * - Non-admins with a dynamicsUserId: always restricted to their own contacts
 * - Non-admins without a dynamicsUserId (unlinked): denied entirely
 */
async function resolveEffectiveOwnerId(
    ctx: { runQuery: (ref: any, args?: any) => Promise<any> },
    requestedOwnerId?: string
): Promise<string | undefined> {
    const user = await ctx.runQuery(api.users.getCurrentUser);
    // Admins retain full control
    if (!user || user.role === "admin") {
        return requestedOwnerId;
    }
    // Non-admin without a Dynamics link: deny all contact access
    if (!user.dynamicsUserId) {
        throw new Error("Your account is not linked to a Dynamics consultant. Please ask an administrator to link your account before accessing contacts.");
    }
    // Non-admin with dynamicsUserId: always enforce their own scope
    return user.dynamicsUserId;
}

/**
 * Contact fields we retrieve from Dynamics 365
 */
const CONTACT_SELECT_FIELDS = [
    "contactid",
    "fullname",
    "firstname",
    "lastname",
    "emailaddress1",
    "mobilephone",
    "statecode",
    "riivo_clienttypenew",
    "riivo_taxmarketing",
    "riivo_accountingmarketing",
    "riivo_insurancemarketing",
    "riivo_whatsappoptinout",
    "icon_sendemailclientnotifications",
    "icon_sendclientssmsnotifications",
    "icon_formattedmobilenumber",
    "createdon",
    "modifiedon",
    "riivo_clienttypeindbus",
    "ttt_bank",
    "riivo_sourcecode",
    "address1_stateorprovince",
    "riivo_age",
    "riivo_geographiclocation",
].join(",");

export interface DynamicsContact {
    contactid: string;
    fullname: string;
    firstname: string | null;
    lastname: string | null;
    emailaddress1: string | null;
    mobilephone: string | null;
    icon_formattedmobilenumber: string | null;
    statecode: number;
    riivo_clienttypenew: string | null;
    riivo_taxmarketing: boolean;
    riivo_accountingmarketing: boolean;
    riivo_insurancemarketing: boolean;
    riivo_whatsappoptinout: boolean;
    icon_sendemailclientnotifications: boolean;
    icon_sendclientssmsnotifications: boolean;
    createdon: string;
    modifiedon: string;
    riivo_clienttypeindbus: number | null;
    ttt_bank: number | null;
    riivo_sourcecode: string | null;
    address1_stateorprovince: string | null;
    riivo_age: number | null;
    riivo_geographiclocation: number | null;
}

/**
 * Fetch contacts from Dynamics 365 with filtering and pagination
 */
export const fetchContacts = action({
    args: {
        filter: v.optional(v.string()), // OData filter expression
        search: v.optional(v.string()), // Search term for name/email
        top: v.optional(v.number()), // Number of records per page
        skip: v.optional(v.number()), // Number of records to skip (for offset pagination)
        skipToken: v.optional(v.string()), // Pagination token (cursor pagination)
        countOnly: v.optional(v.boolean()), // Only return count
        // New filters
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())), // MultiSelect usually returns array or string, for input we take array
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()), // SA Provinces option set (riivo_geographiclocation)
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()), // New industry filter
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const {
            filter,
            search,
            top = 50,
            skip,
            skipToken,
            countOnly,
            clientType,
            entityType,
            bank,
            sourceCode,
            province,
            geographicLocation,
            ageMin,
            ageMax,
            industryId,
            marketingType,
            nameRangeStart,
            nameRangeEnd
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Fetch a single page via the Contact Query module so the recipient list
        // shares one canonical filter definition and never assembles page-size
        // headers or cursor tokens itself.
        const response = await fetchContactsPage<DynamicsContact>(
            {
                filter,
                search,
                clientType,
                entityType,
                bank,
                sourceCode,
                province,
                geographicLocation,
                ageMin,
                ageMax,
                ownerId,
                industryId,
                marketingType,
                nameRangeStart,
                nameRangeEnd,
            },
            {
                select: CONTACT_SELECT_FIELDS,
                pageSize: top,
                cursor: skipToken,
                countOnly,
            }
        );

        // Transform the response
        const contacts = (response.value ?? []).map((contact) => ({
            id: contact.contactid,
            fullName: contact.fullname,
            firstName: contact.firstname,
            lastName: contact.lastname,
            email: contact.emailaddress1,
            phone: contact.mobilephone,
            internationalPhone: contact.icon_formattedmobilenumber,
            isActive: contact.statecode === 0,
            clientType: contact.riivo_clienttypenew,
            marketingPreferences: {
                tax: contact.riivo_taxmarketing,
                accounting: contact.riivo_accountingmarketing,
                insurance: contact.riivo_insurancemarketing,
            },
            whatsappOptIn: contact.riivo_whatsappoptinout,
            emailNotifications: contact.icon_sendemailclientnotifications,
            smsNotifications: contact.icon_sendclientssmsnotifications,
            // New fields
            entityType: contact.riivo_clienttypeindbus,
            bank: contact.ttt_bank,
            sourceCode: contact.riivo_sourcecode,
            province: contact.address1_stateorprovince,
            geographicLocation: contact.riivo_geographiclocation,
            age: contact.riivo_age,
            industryId: (contact as any)._riivo_industryid_value,
            createdOn: contact.createdon,
            modifiedOn: contact.modifiedon,
        }));

        return {
            contacts,
            nextPage: response["@odata.nextLink"] || null,
            totalCount: response["@odata.count"] || null,
        };
    },
});

/**
 * Get count of contacts matching a filter
 */
export const getContactCount = action({
    args: {
        ownerId: v.optional(v.string()),
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        // New filters
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const {
            filter,
            search,
            clientType,
            entityType,
            bank,
            sourceCode,
            province,
            geographicLocation,
            ageMin,
            ageMax,
            industryId,
            marketingType,
            nameRangeStart,
            nameRangeEnd
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Count via the Contact Query module so count, select-all, the recipient
        // list, and the send-time stream all derive their audience from one place.
        // The module handles the Dynamics @odata.count 5000 ceiling internally,
        // paginating contactids to recover the true total when it is hit.
        const count = await countContacts({
            filter,
            search,
            clientType,
            entityType,
            bank,
            sourceCode,
            province,
            geographicLocation,
            ageMin,
            ageMax,
            ownerId,
            industryId,
            marketingType,
            nameRangeStart,
            nameRangeEnd,
        });

        return { count };
    },
});

/**
 * Fetch ALL contact IDs matching a filter (for Select All)
 * Returns lightweight contact objects for campaign creation
 */
export const fetchAllContactIds = action({
    args: {
        ownerId: v.optional(v.string()),
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        // New filters
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const {
            filter,
            search,
            clientType,
            entityType,
            bank,
            sourceCode,
            province,
            geographicLocation,
            ageMin,
            ageMax,
            industryId,
            marketingType,
            nameRangeStart,
            nameRangeEnd
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        interface SimpleContact {
            contactid: string;
            fullname: string;
            emailaddress1: string | null;
            mobilephone: string | null;
            icon_formattedmobilenumber: string | null;
        }

        // We only need basic fields for campaign creation
        const selectFields = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber";

        // Stream every matching contact through the Contact Query module so the
        // select-all audience matches the recipient list, count, and send, and so
        // pagination is handled in one place. 500 pages is the safety cap.
        const allContacts: SimpleContact[] = [];
        await streamContacts<SimpleContact>(
            {
                filter,
                search,
                clientType,
                entityType,
                bank,
                sourceCode,
                province,
                geographicLocation,
                ageMin,
                ageMax,
                ownerId,
                industryId,
                marketingType,
                nameRangeStart,
                nameRangeEnd,
            },
            {
                select: selectFields,
                maxPages: 500,
                onPage: (rows) => {
                    allContacts.push(...rows);
                },
            }
        );

        return allContacts.map((contact) => ({
            id: contact.contactid,
            fullName: contact.fullname,
            email: contact.emailaddress1,
            phone: contact.mobilephone,
            internationalPhone: contact.icon_formattedmobilenumber,
        }));
    },
});

/**
 * Get a single contact by ID
 */
export const getContact = action({
    args: {
        contactId: v.string(),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const endpoint = `contacts(${args.contactId})?$select=${CONTACT_SELECT_FIELDS}`;

        const contact = await dynamicsRequest<DynamicsContact>(endpoint);

        return {
            id: contact.contactid,
            fullName: contact.fullname,
            firstName: contact.firstname,
            lastName: contact.lastname,
            email: contact.emailaddress1,
            phone: contact.mobilephone,
            internationalPhone: contact.icon_formattedmobilenumber,
            isActive: contact.statecode === 0,
            clientType: contact.riivo_clienttypenew,
            marketingPreferences: {
                tax: contact.riivo_taxmarketing,
                accounting: contact.riivo_accountingmarketing,
                insurance: contact.riivo_insurancemarketing,
            },
            whatsappOptIn: contact.riivo_whatsappoptinout,
            emailNotifications: contact.icon_sendemailclientnotifications,
            smsNotifications: contact.icon_sendclientssmsnotifications,
        };
    },
});

/**
 * OptionSet value interface
 */
export interface OptionSetOption {
    value: number;
    label: string;
}

/**
 * Fetch local OptionSet (attribute) options for a specific entity
 */
export const getAttributeOptionSet = action({
    args: {
        entityName: v.string(),
        attributeName: v.string(),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const { entityName, attributeName } = args;

        // Helper to fetch options from a specific metadata type
        const fetchOptions = async (type: string) => {
            const endpoint = `EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.${type}?$select=LogicalName&$expand=OptionSet`;
            const response = await dynamicsRequest<any>(endpoint);
            return response.OptionSet.Options.map((opt: any) => ({
                value: opt.Value,
                label: opt.Label.UserLocalizedLabel.Label,
            }));
        };

        try {
            // 1. Try Standard Picklist
            try {
                const options = await fetchOptions("PicklistAttributeMetadata");
                return { options: options as OptionSetOption[] };
            } catch (e) { /* Continue to fallback */ }

            // 2. Try MultiSelect Picklist
            try {
                const options = await fetchOptions("MultiSelectPicklistAttributeMetadata");
                return { options: options as OptionSetOption[] };
            } catch (e) { /* Continue to fallback */ }

            // 3. Try Boolean (Two Options)
            try {
                const options = await fetchOptions("BooleanAttributeMetadata");
                // Boolean options are usually true/false values (0/1 or similar), structure is slightly different?
                // Usually OptionSet.TrueOption and OptionSet.FalseOption
                // Let's stick to empty if it's boolean for now or try to parse if needed.
                // Actually boolean is often handled differently in UI. Let's skip boolean for now or check structure.
            } catch (e) { /* Continue */ }

            // 4. Debug: What IS this attribute?
            const debugEndpoint = `EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')?$select=AttributeType`;
            try {
                const debugResponse = await dynamicsRequest<any>(debugEndpoint);
                console.error(`Failed to fetch OptionSet for ${entityName}.${attributeName}. Actual AttributeType is: ${debugResponse.AttributeType}`);
                throw new Error(`Attribute ${attributeName} is of type ${debugResponse.AttributeType}, not a Picklist.`);
            } catch (debugErr) {
                console.error(`Failed to fetch attribute metadata for ${entityName}.${attributeName}:`, debugErr);
                throw new Error(`Attribute ${attributeName} metadata not found.`);
            }

        } catch (error) {
            console.error(`Error in getAttributeOptionSet for ${entityName}.${attributeName}:`, error);
            // Return empty options so UI doesn't crash, but log error
            return { options: [] };
        }
    },
});

/**
 * Fetch Global OptionSet by name
 */
export const getGlobalOptionSet = action({
    args: {
        optionSetName: v.string(),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const endpoint = `GlobalOptionSetDefinitions(Name='${args.optionSetName}')`;
        const response = await dynamicsRequest<any>(endpoint);
        const options = response.Options.map((opt: any) => ({
            value: opt.Value,
            label: opt.Label.UserLocalizedLabel.Label,
        }));
        return { options: options as OptionSetOption[] };
    },
});

/**
 * Fetch system users (consultants) from Dynamics
 */
export const fetchUsers = action({
    args: {
        includeDisabled: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const filterParts: string[] = [];

        if (!args.includeDisabled) {
            filterParts.push("isdisabled eq false");
        }

        filterParts.push("not startswith(fullname,'%23')");

        const filterExpr = filterParts.join(" and ");
        const endpoint = `systemusers?$select=systemuserid,fullname,internalemailaddress,mobilephone,isdisabled&$filter=${filterExpr}&$orderby=fullname asc`;

        interface DynamicsUser {
            systemuserid: string;
            fullname: string;
            internalemailaddress?: string;
            mobilephone?: string;
            isdisabled: boolean;
        }

        interface UsersResponse {
            value: DynamicsUser[];
        }

        const response = await dynamicsRequest<UsersResponse>(endpoint);

        return response.value.map(user => ({
            id: user.systemuserid,
            name: user.fullname,
            email: user.internalemailaddress,
            phone: user.mobilephone,
            isDisabled: user.isdisabled,
        }));
    },
});

/**
 * Fetch industries from Dynamics
 */
export const fetchIndustries = action({
    args: {},
    handler: async (ctx) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        // Fetch industries from riivo_industries entity
        // Entity: riivo_industry
        // PK: riivo_industryid
        // Name: riivo_industry
        const endpoint = `riivo_industries?$select=riivo_industryid,riivo_industry&$orderby=riivo_industry asc`;

        interface DynamicsIndustry {
            riivo_industryid: string;
            riivo_industry: string;
        }

        interface IndustriesResponse {
            value: DynamicsIndustry[];
        }

        const response = await dynamicsRequest<IndustriesResponse>(endpoint);

        return response.value.map(industry => ({
            id: industry.riivo_industryid,
            name: industry.riivo_industry,
        }));
    },
});

// ---- ITA34 / IRP5 Tax Data ----

const ITA34_SELECT_FIELDS = [
    "riivo_ita34id",
    "riivo_yearofassessment",
    "riivo_income",
    "riivo_taxableincomeassessedloss",
    "riivo_retirementannuityfundcontributions",
    "riivo_retirementfundcontributions",
    "riivo_providendfundcontributions",
    "riivo_medicalschemefeestaxcredit",
    "riivo_medicalrebatebelow65withnodisability",
    "riivo_dateofassessment",
    "riivo_referencenumber",
    "riivo_taxpayername",
    "_riivo_taxpayercontact_value",
].join(",");

const IRP5_SELECT_FIELDS = [
    "riivo_irp5id",
    "riivo_assessmentyearint",
    "riivo_name",
    "riivo_incomepaye",
    "riivo_grosstaxableincome",
    "riivo_totaldeductionscontributions",
    "riivo_racontributions",
    "riivo_providentfundcontributionpaye",
    "riivo_totalprovidentfundcontributions",
    "riivo_medicalaidcontributions",
    "riivo_medicalschemetaxcredit",
    "riivo_taxabletravelremuneration",
    "riivo_uifcontribution",
    "riivo_sdlcontribution",
    "riivo_totaltaxsdlanduif",
    "riivo_employertradingothername",
    "riivo_taxperiodstartdate",
    "riivo_taxperiodenddate",
    "_riivo_client_value",
].join(",");

// The canonical tax-figure shape (and the readers that produce it) are owned by
// the Tax Profile module.
import type { TaxProfileData } from "../lib/taxProfile";
import {
    resolveSpecialisedAudience,
    ita34IncomeScanAdapter,
    taxReturnScanAdapter,
    badDebtScanAdapter,
    referralScanAdapter,
} from "../lib/specialisedAudience";
export type { TaxProfileData };

export const fetchContactTaxData = action({
    args: {
        contactId: v.string(),
    },
    handler: async (ctx, args): Promise<TaxProfileData> => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const ita34Endpoint = `riivo_ita34s?$select=${ITA34_SELECT_FIELDS}&$filter=_riivo_taxpayercontact_value eq '${args.contactId}'&$orderby=riivo_yearofassessment desc&$top=1`;
        const irp5Endpoint = `riivo_irp5s?$select=${IRP5_SELECT_FIELDS}&$filter=_riivo_client_value eq '${args.contactId}'&$orderby=riivo_assessmentyearint desc&$top=1`;

        const [ita34Response, irp5Response] = await Promise.all([
            dynamicsRequest<{ value: any[] }>(ita34Endpoint),
            dynamicsRequest<{ value: any[] }>(irp5Endpoint),
        ]);

        const ita34 = ita34Response.value[0] || null;
        const irp5 = irp5Response.value[0] || null;

        return {
            contactId: args.contactId,
            ita34: ita34
                ? {
                      yearOfAssessment: ita34.riivo_yearofassessment ?? 0,
                      income: ita34.riivo_income ?? 0,
                      taxableIncome: ita34.riivo_taxableincomeassessedloss ?? 0,
                      raContributions: ita34.riivo_retirementannuityfundcontributions ?? 0,
                      retirementFundContributions: ita34.riivo_retirementfundcontributions ?? 0,
                      providentFundContributions: ita34.riivo_providendfundcontributions ?? 0,
                      medicalSchemeTaxCredit: ita34.riivo_medicalschemefeestaxcredit ?? 0,
                      medicalRebate: ita34.riivo_medicalrebatebelow65withnodisability ?? 0,
                      dateOfAssessment: ita34.riivo_dateofassessment ?? null,
                      referenceNumber: ita34.riivo_referencenumber ?? null,
                  }
                : null,
            irp5: irp5
                ? {
                      assessmentYear: irp5.riivo_assessmentyearint ?? 0,
                      incomePaye: irp5.riivo_incomepaye ?? 0,
                      grossTaxableIncome: irp5.riivo_grosstaxableincome ?? 0,
                      totalDeductions: irp5.riivo_totaldeductionscontributions ?? 0,
                      raContributions: irp5.riivo_racontributions ?? null,
                      providentFundContribution: irp5.riivo_providentfundcontributionpaye ?? 0,
                      totalProvidentFund: irp5.riivo_totalprovidentfundcontributions ?? 0,
                      medicalAidContributions: irp5.riivo_medicalaidcontributions ?? 0,
                      medicalSchemeTaxCredit: irp5.riivo_medicalschemetaxcredit ?? 0,
                      taxableTravel: irp5.riivo_taxabletravelremuneration ?? 0,
                      employerName: irp5.riivo_employertradingothername ?? null,
                      taxPeriodStart: irp5.riivo_taxperiodstartdate ?? null,
                      taxPeriodEnd: irp5.riivo_taxperiodenddate ?? null,
                  }
                : null,
        };
    },
});

/**
 * Fetch contacts that have ITA34 records, with optional income/RA filters.
 * Two-step approach: query ITA34s first, then resolve linked contacts.
 */
export const fetchContactsWithITA34 = action({
    args: {
        incomeMin: v.optional(v.number()),
        incomeMax: v.optional(v.number()),
        retirementFundMin: v.optional(v.number()),
        retirementFundMax: v.optional(v.number()),
        taxYear: v.optional(v.number()),
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        // Replace args.ownerId with the enforced value for the rest of the handler
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        // Membership (who has latest-year income in range), latest-year selection,
        // and the id-chunked contact re-query all live in the Specialised Audience
        // module / Contact Query. This handler is now the rich-list-shape mapper:
        // the resolver hands back each contact joined with its Tax Profile display
        // figures so the list shows the same latest-year taxable income as the
        // preview and the sent email.
        const contacts: Array<{
            id: string;
            fullName: string;
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            phone: string | null;
            internationalPhone: string | null;
            isActive: boolean;
            clientType: string | null;
            marketingPreferences: { tax: boolean; accounting: boolean; insurance: boolean };
            whatsappOptIn: boolean;
            emailNotifications: boolean;
            smsNotifications: boolean;
            createdOn: string;
            modifiedOn: string;
            ita34Income: number | null;
            ita34RetirementFund: number | null;
            ita34Year: number | null;
        }> = [];

        await resolveSpecialisedAudience<DynamicsContact>({
            adapter: ita34IncomeScanAdapter({
                incomeMin: args.incomeMin,
                incomeMax: args.incomeMax,
                retirementFundMin: args.retirementFundMin,
                retirementFundMax: args.retirementFundMax,
                taxYear: args.taxYear,
            }),
            filter: resolvedArgs,
            select: CONTACT_SELECT_FIELDS,
            withTaxProfile: true,
            onChunk: (resolved) => {
                for (const { contact: c, extra } of resolved) {
                    const ita34 = extra.taxProfile?.ita34 ?? null;
                    contacts.push({
                        id: c.contactid,
                        fullName: c.fullname,
                        firstName: c.firstname,
                        lastName: c.lastname,
                        email: c.emailaddress1,
                        phone: c.mobilephone,
                        internationalPhone: c.icon_formattedmobilenumber,
                        isActive: c.statecode === 0,
                        clientType: c.riivo_clienttypenew,
                        marketingPreferences: {
                            tax: c.riivo_taxmarketing,
                            accounting: c.riivo_accountingmarketing,
                            insurance: c.riivo_insurancemarketing,
                        },
                        whatsappOptIn: c.riivo_whatsappoptinout,
                        emailNotifications: c.icon_sendemailclientnotifications,
                        smsNotifications: c.icon_sendclientssmsnotifications,
                        createdOn: c.createdon,
                        modifiedOn: c.modifiedon,
                        // ita34Income carries the displayed figure: taxable income.
                        ita34Income: ita34?.taxableIncome ?? null,
                        ita34RetirementFund: ita34?.retirementFundContributions ?? null,
                        ita34Year: ita34?.yearOfAssessment ?? null,
                    });
                }
            },
        });

        return { contacts, totalCount: contacts.length };
    },
});

// ---- Tax Return (SARS Reimbursement) Contact Filtering ----

/**
 * Fetch contacts that received a SARS reimbursement above a minimum threshold
 * from the new_invoiceses entity, then resolve linked contact records.
 * Optionally scoped to a specific year (defaults to the previous calendar year).
 */
export const fetchContactsByTaxReturn = action({
    args: {
        taxReturnMin: v.number(),
        taxReturnYear: v.optional(v.number()),
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        const targetYear = args.taxReturnYear ?? (new Date().getFullYear() - 1);

        // The scan (highest reimbursement per contact in the year window) and the
        // id-chunked contact re-query live in the Specialised Audience module /
        // Contact Query. This handler is the rich-list-shape mapper. This audience
        // displays the reimbursement amount directly — it is the scan figure — so
        // no Tax Profile join is requested and `extra.scanFigure` carries it.
        const contacts: Array<{
            id: string;
            fullName: string;
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            phone: string | null;
            internationalPhone: string | null;
            isActive: boolean;
            clientType: string | null;
            marketingPreferences: { tax: boolean; accounting: boolean; insurance: boolean };
            whatsappOptIn: boolean;
            emailNotifications: boolean;
            smsNotifications: boolean;
            createdOn: string;
            modifiedOn: string;
            sarsReimbursement: number | null;
        }> = [];

        await resolveSpecialisedAudience<DynamicsContact>({
            adapter: taxReturnScanAdapter({
                taxReturnMin: args.taxReturnMin,
                targetYear,
            }),
            filter: resolvedArgs,
            select: CONTACT_SELECT_FIELDS,
            onChunk: (resolved) => {
                for (const { contact: c, extra } of resolved) {
                    contacts.push({
                        id: c.contactid,
                        fullName: c.fullname,
                        firstName: c.firstname,
                        lastName: c.lastname,
                        email: c.emailaddress1,
                        phone: c.mobilephone,
                        internationalPhone: c.icon_formattedmobilenumber,
                        isActive: c.statecode === 0,
                        clientType: c.riivo_clienttypenew,
                        marketingPreferences: {
                            tax: c.riivo_taxmarketing,
                            accounting: c.riivo_accountingmarketing,
                            insurance: c.riivo_insurancemarketing,
                        },
                        whatsappOptIn: c.riivo_whatsappoptinout,
                        emailNotifications: c.icon_sendemailclientnotifications,
                        smsNotifications: c.icon_sendclientssmsnotifications,
                        createdOn: c.createdon,
                        modifiedOn: c.modifiedon,
                        sarsReimbursement: extra.scanFigure,
                    });
                }
            },
        });

        return { contacts, totalCount: contacts.length };
    },
});

// ---- Leads ----

const LEAD_SELECT_FIELDS = [
    "new_leadid",
    "new_name",
    "ttt_firstname",
    "ttt_lastname",
    "ttt_email",
    "ttt_mobilephone",
    "statecode",
    "statuscode",
    "riivo_accountname",
    "riivo_province",
    "riivo_emailoptin",
    "riivo_whatsappoptin",
    "riivo_industry",
    "riivo_leadtype",
    "_riivo_industry_lookup_value",
    "createdon",
    "modifiedon",
    "_ownerid_value",
].join(",");

interface DynamicsLead {
    new_leadid: string;
    new_name: string;
    ttt_firstname: string | null;
    ttt_lastname: string | null;
    ttt_email: string | null;
    ttt_mobilephone: string | null;
    statecode: number;
    statuscode: number;
    riivo_accountname: string | null;
    riivo_province: string | null;
    riivo_emailoptin: boolean;
    riivo_whatsappoptin: boolean;
    riivo_industry: string | null;
    riivo_leadtype: string | null;
    _riivo_industry_lookup_value: string | null;
    createdon: string;
    modifiedon: string;
    _ownerid_value: string | null;
}

function mapLeadToContact(lead: DynamicsLead) {
    return {
        id: lead.new_leadid,
        fullName: lead.new_name || `${lead.ttt_firstname ?? ""} ${lead.ttt_lastname ?? ""}`.trim() || "Unknown",
        firstName: lead.ttt_firstname,
        lastName: lead.ttt_lastname,
        email: lead.ttt_email,
        phone: lead.ttt_mobilephone,
        internationalPhone: lead.ttt_mobilephone,
        isActive: lead.statecode === 0,
        clientType: "lead",
        marketingPreferences: { tax: false, accounting: false, insurance: false },
        whatsappOptIn: lead.riivo_whatsappoptin,
        emailNotifications: lead.riivo_emailoptin,
        smsNotifications: false,
        createdOn: lead.createdon,
        modifiedOn: lead.modifiedon,
        industry: lead.riivo_industry,
        industryId: lead._riivo_industry_lookup_value,
    };
}

/**
 * Build a typed {@link LeadFilter} from action args. Owner scope is resolved at
 * the action seam and passed in; every other clause comes straight from the
 * typed args. The Lead Query module turns this into the OData expression — the
 * dialect never appears here.
 */
function toLeadFilter(args: {
    search?: string;
    province?: string;
    emailOptIn?: boolean;
    whatsappOptIn?: boolean;
    status?: string;
    industryId?: string;
    channel?: string;
}, ownerId?: string): LeadFilter {
    return {
        status: args.status,
        search: args.search,
        province: args.province,
        emailOptIn: args.emailOptIn,
        whatsappOptIn: args.whatsappOptIn,
        ownerId,
        industryId: args.industryId,
        // Channel contactability rides as a typed dimension; the Lead Query module
        // emits the ttt_email / ttt_mobilephone ne null clause so count, list, and
        // Select All stay in sync with the send path (which drops leads that have
        // no email on email/personalised, or no phone on whatsapp).
        channel: args.channel,
    };
}

/**
 * Fetch leads from Dynamics 365 with filtering and pagination
 */
export const fetchLeads = action({
    args: {
        search: v.optional(v.string()),
        top: v.optional(v.number()),
        skip: v.optional(v.number()),
        skipToken: v.optional(v.string()),
        province: v.optional(v.string()),
        emailOptIn: v.optional(v.boolean()),
        whatsappOptIn: v.optional(v.boolean()),
        ownerId: v.optional(v.string()),
        status: v.optional(v.string()),
        industryId: v.optional(v.string()),
        channel: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");

        const { top = 50 } = args;
        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Fetch a single page via the Lead Query module so the recipient list
        // shares one canonical filter definition and never assembles page-size
        // headers or cursor tokens itself.
        const response = await fetchLeadsPage<DynamicsLead>(
            toLeadFilter(args, ownerId),
            {
                select: LEAD_SELECT_FIELDS,
                pageSize: top,
                cursor: args.skipToken,
            }
        );

        return {
            contacts: (response.value ?? []).map(mapLeadToContact),
            nextPage: response["@odata.nextLink"] || null,
            totalCount: response["@odata.count"] || null,
        };
    },
});

/**
 * Get count of leads matching a filter
 */
export const getLeadCount = action({
    args: {
        search: v.optional(v.string()),
        province: v.optional(v.string()),
        emailOptIn: v.optional(v.boolean()),
        whatsappOptIn: v.optional(v.boolean()),
        ownerId: v.optional(v.string()),
        status: v.optional(v.string()),
        industryId: v.optional(v.string()),
        channel: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Count via the Lead Query module so count, select-all, and the recipient
        // list all derive their audience from one place. The module handles the
        // Dynamics @odata.count ceiling internally, paginating lead ids to recover
        // the true total when it is hit.
        const count = await countLeads(toLeadFilter(args, ownerId));

        return { count };
    },
});

/**
 * Fetch ALL lead IDs matching a filter (for Select All)
 */
export const fetchAllLeadIds = action({
    args: {
        search: v.optional(v.string()),
        province: v.optional(v.string()),
        emailOptIn: v.optional(v.boolean()),
        whatsappOptIn: v.optional(v.boolean()),
        ownerId: v.optional(v.string()),
        status: v.optional(v.string()),
        industryId: v.optional(v.string()),
        channel: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        interface SimpleLead {
            new_leadid: string;
            new_name: string;
            ttt_email: string | null;
            ttt_mobilephone: string | null;
        }

        const selectFields = "new_leadid,new_name,ttt_email,ttt_mobilephone";

        // Stream every matching lead through the Lead Query module so the
        // select-all audience matches the recipient list and count, and so
        // pagination is handled in one place. 500 pages is the safety cap.
        const allLeads: SimpleLead[] = [];
        await streamLeads<SimpleLead>(toLeadFilter(args, ownerId), {
            select: selectFields,
            maxPages: 500,
            onPage: (rows) => {
                allLeads.push(...rows);
            },
        });

        return allLeads.map((lead) => ({
            id: lead.new_leadid,
            fullName: lead.new_name,
            email: lead.ttt_email,
            phone: lead.ttt_mobilephone,
            internationalPhone: lead.ttt_mobilephone,
        }));
    },
});

// ---- Bad Debt (Open Invoices) Contact Filtering ----

/**
 * Fetch contacts that have at least one open invoice (bad debt).
 *
 * The scan (open invoices with a positive outstanding balance, collapsed to the
 * highest outstanding per contact) and the id-chunked contact re-query live in the
 * Specialised Audience module / Contact Query; this handler is the rich-list-shape
 * mapper. The audience displays the outstanding amount directly — it is the scan
 * figure — so no Tax Profile join is requested and `extra.scanFigure` carries it.
 */
export const fetchContactsByBadDebt = action({
    args: {
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        const contacts: Array<{
            id: string;
            fullName: string;
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            phone: string | null;
            internationalPhone: string | null;
            isActive: boolean;
            clientType: string | null;
            marketingPreferences: { tax: boolean; accounting: boolean; insurance: boolean };
            whatsappOptIn: boolean;
            emailNotifications: boolean;
            smsNotifications: boolean;
            createdOn: string;
            modifiedOn: string;
            outstandingAmount: number | null;
        }> = [];

        await resolveSpecialisedAudience<DynamicsContact>({
            adapter: badDebtScanAdapter(),
            filter: resolvedArgs,
            select: CONTACT_SELECT_FIELDS,
            onChunk: (resolved) => {
                for (const { contact: c, extra } of resolved) {
                    contacts.push({
                        id: c.contactid,
                        fullName: c.fullname,
                        firstName: c.firstname,
                        lastName: c.lastname,
                        email: c.emailaddress1,
                        phone: c.mobilephone,
                        internationalPhone: c.icon_formattedmobilenumber,
                        isActive: c.statecode === 0,
                        clientType: c.riivo_clienttypenew,
                        marketingPreferences: {
                            tax: c.riivo_taxmarketing,
                            accounting: c.riivo_accountingmarketing,
                            insurance: c.riivo_insurancemarketing,
                        },
                        whatsappOptIn: c.riivo_whatsappoptinout,
                        emailNotifications: c.icon_sendemailclientnotifications,
                        smsNotifications: c.icon_sendclientssmsnotifications,
                        createdOn: c.createdon,
                        modifiedOn: c.modifiedon,
                        outstandingAmount: extra.scanFigure,
                    });
                }
            },
        });

        return { contacts, totalCount: contacts.length };
    },
});

/**
 * Fetch "referral participants" — the distinct contacts who have referred someone.
 *
 * The contact field `_riivo_referredby_value` on contact A holds the ID of the
 * person who referred A. So the set of referrers is the set of distinct values
 * appearing in that field across all contacts. We collect those IDs, then fetch
 * the referrer contacts themselves as recipients (applying the channel filter and
 * all standard extra filters, exactly like fetchContactsByBadDebt).
 *
 * Referrer IDs that don't resolve to an active (statecode eq 0), contactable
 * contact are skipped silently — they simply aren't returned.
 */
export const fetchReferralParticipants = action({
    args: {
        filter: v.optional(v.string()),
        search: v.optional(v.string()),
        clientType: v.optional(v.array(v.number())),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        geographicLocation: v.optional(v.number()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
        marketingType: v.optional(v.union(v.literal("tax"), v.literal("accounting"), v.literal("insurance"))), // Marketing-consent type (typed dimension)
        nameRangeStart: v.optional(v.string()), // Alphabetical name range (typed dimension)
        nameRangeEnd: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        // The referrer scan (distinct _riivo_referredby_value set) and the id-chunked
        // contact re-query live in the Specialised Audience module / Contact Query;
        // this handler is the rich-list-shape mapper. The re-query re-applies
        // statecode eq 0 + the channel filter, so inactive / non-contactable referrers
        // fall away silently. This audience has no per-contact figure to display.
        const contacts: Array<{
            id: string;
            fullName: string;
            firstName: string | null;
            lastName: string | null;
            email: string | null;
            phone: string | null;
            internationalPhone: string | null;
            isActive: boolean;
            clientType: string | null;
            marketingPreferences: { tax: boolean; accounting: boolean; insurance: boolean };
            whatsappOptIn: boolean;
            emailNotifications: boolean;
            smsNotifications: boolean;
            createdOn: string;
            modifiedOn: string;
        }> = [];

        await resolveSpecialisedAudience<DynamicsContact>({
            adapter: referralScanAdapter(),
            filter: resolvedArgs,
            select: CONTACT_SELECT_FIELDS,
            onChunk: (resolved) => {
                for (const { contact: c } of resolved) {
                    contacts.push({
                        id: c.contactid,
                        fullName: c.fullname,
                        firstName: c.firstname,
                        lastName: c.lastname,
                        email: c.emailaddress1,
                        phone: c.mobilephone,
                        internationalPhone: c.icon_formattedmobilenumber,
                        isActive: c.statecode === 0,
                        clientType: c.riivo_clienttypenew,
                        marketingPreferences: {
                            tax: c.riivo_taxmarketing,
                            accounting: c.riivo_accountingmarketing,
                            insurance: c.riivo_insurancemarketing,
                        },
                        whatsappOptIn: c.riivo_whatsappoptinout,
                        emailNotifications: c.icon_sendemailclientnotifications,
                        smsNotifications: c.icon_sendclientssmsnotifications,
                        createdOn: c.createdon,
                        modifiedOn: c.modifiedon,
                    });
                }
            },
        });

        return { contacts, totalCount: contacts.length };
    },
});

// ---- CRM Opportunity Management ----

/** Temperature values for riivo_opportunitytemperature OptionSet */
export const OPPORTUNITY_TEMPERATURE = {
    PENDING: 463630000,
    COLD: 463630001,
    WARM: 463630002,
    HOT: 463630003,
} as const;

/**
 * Create a new opportunity in riivo_opportunities linked to a contact.
 * Sets riivo_automatedopportunity = true and initial temperature = Pending (0).
 * Returns the new riivo_opportunityid.
 */
export const createOpportunity = internalAction({
    args: {
        contactId: v.string(),
        contactName: v.string(),
        campaignId: v.string(),
        ownerId: v.optional(v.string()),
    },
    handler: async (_ctx, args): Promise<string | null> => {
        try {
            const opportunityName = `TAX-${new Date().getFullYear()}-${args.contactName.substring(0, 30).trim()}`;

            const body: Record<string, unknown> = {
                riivo_name: opportunityName,
                "riivo_Client@odata.bind": `/contacts(${args.contactId})`,
                riivo_automatedopportunity: true,
                riivo_notyetcontacted: true,
                riivo_opportunitytemperature: OPPORTUNITY_TEMPERATURE.PENDING,
            };

            if (args.ownerId) {
                body["ownerid@odata.bind"] = `/systemusers(${args.ownerId})`;
            }

            // Prefer: return=representation asks Dynamics to return the created entity as 201
            // so riivo_opportunityid is in the response body.
            // If Dynamics returns 204 instead (some environments ignore the Prefer header),
            // dynamicsRequest extracts the GUID from the OData-EntityId header as _entityId.
            const response = await dynamicsRequest<{ riivo_opportunityid?: string; _entityId?: string }>(
                "riivo_opportunities",
                {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: {
                        Prefer: 'return=representation,odata.include-annotations="*"',
                    },
                }
            );

            return response.riivo_opportunityid ?? response._entityId ?? null;
        } catch (err) {
            console.error(`Failed to create opportunity for contact ${args.contactId}:`, err);
            return null;
        }
    },
});

/**
 * Update the temperature of an existing opportunity.
 * Only upgrades temperature — will not overwrite Hot with Warm.
 */
export const updateOpportunityTemperature = internalAction({
    args: {
        opportunityId: v.string(),
        temperature: v.number(), // 0=Pending, 1=Cold, 2=Warm, 3=Hot
    },
    handler: async (_ctx, args): Promise<boolean> => {
        try {
            await dynamicsRequest(
                `riivo_opportunities(${args.opportunityId})`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        riivo_opportunitytemperature: args.temperature,
                        // Mark as contacted when temperature goes above Pending
                        ...(args.temperature > OPPORTUNITY_TEMPERATURE.PENDING
                            ? { riivo_notyetcontacted: false, riivo_contacted: true }
                            : {}),
                    }),
                }
            );
            return true;
        } catch (err) {
            console.error(`Failed to update opportunity temperature for ${args.opportunityId}:`, err);
            return false;
        }
    },
});
