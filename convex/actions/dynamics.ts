"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { dynamicsRequest } from "../lib/dynamics_auth";
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
}

interface ContactsResponse {
    "@odata.context": string;
    "@odata.nextLink"?: string;
    "@odata.count"?: number;
    value: DynamicsContact[];
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
        clientType: v.optional(v.string()),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())), // MultiSelect usually returns array or string, for input we take array
        province: v.optional(v.string()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()), // New industry filter
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
            ageMin,
            ageMax,
            industryId
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Build OData query parameters
        const queryParts: string[] = [];

        // Select specific fields
        queryParts.push(`$select=${CONTACT_SELECT_FIELDS}`);

        // Always filter for active contacts (statecode = 0)
        let filterExpression = "statecode eq 0";

        // Add custom filter if provided
        if (filter) {
            filterExpression += ` and (${filter})`;
        }

        // Add search if provided (search in fullname or emailaddress1)
        if (search) {
            const searchTerm = search.replace(/'/g, "''"); // Escape single quotes
            filterExpression += ` and (contains(fullname,'${searchTerm}') or contains(emailaddress1,'${searchTerm}'))`;
        }

        // --- New Filters ---

        if (clientType) {
            filterExpression += ` and riivo_clienttypenew eq ${clientType}`; // clienttypenew is likely OptionSet (int) but we receive string/number
        }

        if (entityType !== undefined) {
            filterExpression += ` and riivo_clienttypeindbus eq ${entityType}`;
        }

        if (bank !== undefined) {
            filterExpression += ` and ttt_bank eq ${bank}`;
        }

        if (sourceCode && sourceCode.length > 0) {
            // For MultiSelect, use containment or OR logic. 
            // Dynamics 365 MultiSelect filtering: Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['1','2'])
            // Ideally we construct a string of values.
            // Simplified: "contain-values"
            const values = sourceCode.map(String).join("','");
            filterExpression += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
        }

        if (province) {
            const prov = province.replace(/'/g, "''");
            filterExpression += ` and address1_stateorprovince eq '${prov}'`;
        }

        if (ageMin !== undefined) {
            filterExpression += ` and riivo_age ge ${ageMin}`;
        }

        if (ageMax !== undefined) {
            filterExpression += ` and riivo_age le ${ageMax}`;
        }

        if (ownerId) {
            filterExpression += ` and _ownerid_value eq '${ownerId}'`;
        }

        if (industryId) {
            filterExpression += ` and _riivo_industryid_value eq '${industryId}'`;
        }

        console.log(`[fetchContacts] Filter Expression: ${filterExpression}`);

        queryParts.push(`$filter=${filterExpression}`);

        // Order by name
        queryParts.push("$orderby=fullname asc");

        // For count-only queries, use $top=1 to minimise data transfer
        if (countOnly) {
            queryParts.push("$count=true");
            queryParts.push("$top=1");
        }
        // Do NOT add $top for normal paged queries — Dynamics ignores @odata.nextLink when
        // $top is present (it treats $top as a hard limit, not a page size).
        // Page size is controlled exclusively via the Prefer: odata.maxpagesize header.

        // Build the endpoint
        let endpoint = `contacts?${queryParts.join("&")}`;

        // If we have a skipToken, use it for pagination
        if (skipToken) {
            endpoint = skipToken.replace(/^.*\/api\/data\/v9\.2\//, "");
        }

        // odata.maxpagesize controls page size and triggers @odata.nextLink in the response
        const response = await dynamicsRequest<ContactsResponse>(endpoint, {
            headers: {
                Prefer: `odata.include-annotations="*",odata.maxpagesize=${top}`,
            },
        });

        // Transform the response
        const contacts = response.value.map((contact) => ({
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
        clientType: v.optional(v.string()),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        industryId: v.optional(v.string()),
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
            ageMin,
            ageMax,
            industryId
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Build filter expression
        let filterExpression = "statecode eq 0";

        if (filter) {
            filterExpression += ` and (${filter})`;
        }

        if (search) {
            const searchTerm = search.replace(/'/g, "''");
            filterExpression += ` and (contains(fullname,'${searchTerm}') or contains(emailaddress1,'${searchTerm}'))`;
        }

        if (clientType) {
            filterExpression += ` and riivo_clienttypenew eq ${clientType}`;
        }

        if (entityType !== undefined) {
            filterExpression += ` and riivo_clienttypeindbus eq ${entityType}`;
        }

        if (bank !== undefined) {
            filterExpression += ` and ttt_bank eq ${bank}`;
        }

        if (sourceCode && sourceCode.length > 0) {
            const values = sourceCode.map(String).join("','");
            filterExpression += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
        }

        if (province) {
            const prov = province.replace(/'/g, "''");
            filterExpression += ` and address1_stateorprovince eq '${prov}'`;
        }

        if (ageMin !== undefined) {
            filterExpression += ` and riivo_age ge ${ageMin}`;
        }

        if (ageMax !== undefined) {
            filterExpression += ` and riivo_age le ${ageMax}`;
        }

        if (ownerId) {
            filterExpression += ` and _ownerid_value eq '${ownerId}'`;
        }

        if (industryId) {
            filterExpression += ` and _riivo_industryid_value eq '${industryId}'`;
        }



        console.log(`[getContactCount] Filter Expression: ${filterExpression}`);

        const endpoint = `contacts?$filter=${filterExpression}&$count=true&$top=5`;

        const response = await dynamicsRequest<ContactsResponse>(endpoint);

        return {
            count: response["@odata.count"] || 0,
        };
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
        clientType: v.optional(v.string()),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        industryId: v.optional(v.string()),
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
            ageMin,
            ageMax,
            industryId
        } = args;

        const ownerId = await resolveEffectiveOwnerId(ctx, args.ownerId);

        // Build filter expression
        let filterExpression = "statecode eq 0";

        if (filter) {
            filterExpression += ` and (${filter})`;
        }

        if (search) {
            const searchTerm = search.replace(/'/g, "''");
            filterExpression += ` and (contains(fullname,'${searchTerm}') or contains(emailaddress1,'${searchTerm}'))`;
        }

        if (clientType) {
            filterExpression += ` and riivo_clienttypenew eq ${clientType}`;
        }

        if (entityType !== undefined) {
            filterExpression += ` and riivo_clienttypeindbus eq ${entityType}`;
        }

        if (bank !== undefined) {
            filterExpression += ` and ttt_bank eq ${bank}`;
        }

        if (sourceCode && sourceCode.length > 0) {
            const values = sourceCode.map(String).join("','");
            filterExpression += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
        }

        if (province) {
            const prov = province.replace(/'/g, "''");
            filterExpression += ` and address1_stateorprovince eq '${prov}'`;
        }

        if (ageMin !== undefined) {
            filterExpression += ` and riivo_age ge ${ageMin}`;
        }

        if (ageMax !== undefined) {
            filterExpression += ` and riivo_age le ${ageMax}`;
        }

        if (ownerId) {
            filterExpression += ` and _ownerid_value eq '${ownerId}'`;
        }

        if (industryId) {
            filterExpression += ` and _riivo_industryid_value eq '${industryId}'`;
        }

        console.log(`[fetchAllContactIds] Filter Expression: ${filterExpression}`);

        // We only need basic fields for campaign creation
        const selectFields = "contactid,fullname,emailaddress1,mobilephone,icon_formattedmobilenumber";

        const initialEndpoint = `contacts?$filter=${filterExpression}&$select=${selectFields}&$orderby=fullname asc`;

        interface SimpleContact {
            contactid: string;
            fullname: string;
            emailaddress1: string | null;
            mobilephone: string | null;
            icon_formattedmobilenumber: string | null;
            // Include other fields if they are in the response but we only asked for these
        }

        interface SimpleContactsResponse {
            "@odata.context": string;
            "@odata.nextLink"?: string;
            value: SimpleContact[];
        }

        let allContacts: SimpleContact[] = [];
        let nextLink: string | null = initialEndpoint;

        // Loop through pages
        // Safety break to prevent infinite loops if something goes wrong
        let pageCount = 0;
        const MAX_PAGES = 500; // 500 * 50 = 25000 records, should be enough for now. 
        // Note: Dynamics usually returns 5000 records per page if not specified, but we didn't specify page size so it might default to 50 or 5000.
        // Let's rely on nextLink.

        while (nextLink && pageCount < MAX_PAGES) {
            pageCount++;

            // If nextLink is a full URL (from OData response), extract relative part
            // Dynamics nextLink is usually full URL
            if (nextLink.startsWith("http")) {
                // We need to keep the query part but remove the base URL
                // Ideally dynamicsRequest handles full URLs if we pass them? 
                // Looking at dynamicsRequest implementation would be good but let's assume it takes relative path based on existing code 
                // "endpoint = skipToken.replace(/^.*\/api\/data\/v9\.2\//, "");" in fetchContacts suggests we need to strip base.
                nextLink = nextLink.replace(/^.*\/api\/data\/v9\.2\//, "");
            }

            const response: SimpleContactsResponse = await dynamicsRequest<SimpleContactsResponse>(nextLink);

            if (response.value && response.value.length > 0) {
                allContacts.push(...response.value);
            }

            nextLink = response["@odata.nextLink"] || null;
        }

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
        clientType: v.optional(v.string()),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        // Replace args.ownerId with the enforced value for the rest of the handler
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        let ita34Filter = "statecode eq 0 and _riivo_taxpayercontact_value ne null";

        if (args.taxYear) {
            ita34Filter += ` and riivo_yearofassessment eq ${args.taxYear}`;
        }
        if (args.incomeMin !== undefined) {
            ita34Filter += ` and riivo_income ge ${args.incomeMin}`;
        }
        if (args.incomeMax !== undefined) {
            ita34Filter += ` and riivo_income le ${args.incomeMax}`;
        }
        if (args.retirementFundMin !== undefined) {
            ita34Filter += ` and riivo_retirementfundcontributions ge ${args.retirementFundMin}`;
        }
        if (args.retirementFundMax !== undefined) {
            ita34Filter += ` and riivo_retirementfundcontributions le ${args.retirementFundMax}`;
        }

        const ita34Endpoint = `riivo_ita34s?$select=_riivo_taxpayercontact_value,riivo_income,riivo_retirementfundcontributions,riivo_yearofassessment&$filter=${ita34Filter}&$orderby=riivo_yearofassessment desc`;

        interface ITA34Row {
            _riivo_taxpayercontact_value: string;
            riivo_income: number | null;
            riivo_retirementfundcontributions: number | null;
            riivo_yearofassessment: number | null;
        }

        let allIta34s: ITA34Row[] = [];
        let nextLink: string | null = ita34Endpoint;
        let pageCount = 0;

        while (nextLink && pageCount < 100) {
            pageCount++;
            const endpoint: string = nextLink.startsWith("http")
                ? nextLink.replace(/^.*\/api\/data\/v9\.2\//, "")
                : nextLink;
            const response = await dynamicsRequest<{ value: ITA34Row[]; "@odata.nextLink"?: string }>(endpoint);
            if (response.value?.length) {
                allIta34s.push(...response.value);
            }
            nextLink = response["@odata.nextLink"] ?? null;
        }

        const contactMap = new Map<string, ITA34Row>();
        for (const row of allIta34s) {
            const cid = row._riivo_taxpayercontact_value;
            if (!cid) continue;
            const existing = contactMap.get(cid);
            if (!existing || (row.riivo_yearofassessment ?? 0) > (existing.riivo_yearofassessment ?? 0)) {
                contactMap.set(cid, row);
            }
        }

        const contactIds = Array.from(contactMap.keys());
        if (contactIds.length === 0) return { contacts: [], totalCount: 0 };

        // Build additional contact-level filter conditions
        let extraFilter = "";
        if (resolvedArgs.filter) {
            extraFilter += ` and (${resolvedArgs.filter})`;
        }
        if (resolvedArgs.search) {
            const s = resolvedArgs.search.replace(/'/g, "''");
            extraFilter += ` and (contains(fullname,'${s}') or contains(emailaddress1,'${s}'))`;
        }
        if (resolvedArgs.clientType) {
            extraFilter += ` and riivo_clienttypenew eq ${resolvedArgs.clientType}`;
        }
        if (resolvedArgs.entityType !== undefined) {
            extraFilter += ` and riivo_clienttypeindbus eq ${resolvedArgs.entityType}`;
        }
        if (resolvedArgs.bank !== undefined) {
            extraFilter += ` and ttt_bank eq ${resolvedArgs.bank}`;
        }
        if (resolvedArgs.sourceCode && resolvedArgs.sourceCode.length > 0) {
            const values = resolvedArgs.sourceCode.map(String).join("','");
            extraFilter += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
        }
        if (resolvedArgs.province) {
            const prov = resolvedArgs.province.replace(/'/g, "''");
            extraFilter += ` and address1_stateorprovince eq '${prov}'`;
        }
        if (resolvedArgs.ageMin !== undefined) {
            extraFilter += ` and riivo_age ge ${resolvedArgs.ageMin}`;
        }
        if (resolvedArgs.ageMax !== undefined) {
            extraFilter += ` and riivo_age le ${resolvedArgs.ageMax}`;
        }
        if (resolvedArgs.ownerId) {
            extraFilter += ` and _ownerid_value eq '${resolvedArgs.ownerId}'`;
        }
        if (resolvedArgs.industryId) {
            extraFilter += ` and _riivo_industryid_value eq '${resolvedArgs.industryId}'`;
        }

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

        for (let i = 0; i < contactIds.length; i += 50) {
            const batch = contactIds.slice(i, i + 50);
            const idFilter = batch.map((id) => `contactid eq '${id}'`).join(" or ");
            const contactEndpoint = `contacts?$select=${CONTACT_SELECT_FIELDS}&$filter=statecode eq 0 and (${idFilter})${extraFilter}&$orderby=fullname asc`;
            const contactResponse = await dynamicsRequest<{ value: DynamicsContact[] }>(contactEndpoint);

            for (const c of contactResponse.value) {
                const ita34Row = contactMap.get(c.contactid);
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
                    ita34Income: ita34Row?.riivo_income ?? null,
                    ita34RetirementFund: ita34Row?.riivo_retirementfundcontributions ?? null,
                    ita34Year: ita34Row?.riivo_yearofassessment ?? null,
                });
            }
        }

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
        clientType: v.optional(v.string()),
        entityType: v.optional(v.number()),
        bank: v.optional(v.number()),
        sourceCode: v.optional(v.array(v.number())),
        province: v.optional(v.string()),
        ageMin: v.optional(v.number()),
        ageMax: v.optional(v.number()),
        ownerId: v.optional(v.string()),
        industryId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const effectiveOwnerId = await resolveEffectiveOwnerId(ctx, args.ownerId);
        const resolvedArgs = { ...args, ownerId: effectiveOwnerId };

        const targetYear = args.taxReturnYear ?? (new Date().getFullYear() - 1);
        const yearStart = `${targetYear}-01-01T00:00:00Z`;
        const yearEnd = `${targetYear + 1}-01-01T00:00:00Z`;

        // Build invoice filter: reimbursement above threshold within the target year
        let invoiceFilter = `ttt_sarsreimbursement ge ${args.taxReturnMin}`;
        invoiceFilter += ` and createdon ge ${yearStart} and createdon lt ${yearEnd}`;
        invoiceFilter += ` and _ttt_customer_value ne null`;
        invoiceFilter += ` and statecode eq 1`; // Inactive/completed invoices

        const invoiceEndpoint = `new_invoiceses?$select=_ttt_customer_value,ttt_sarsreimbursement,createdon&$filter=${invoiceFilter}&$orderby=ttt_sarsreimbursement desc`;

        interface InvoiceRow {
            _ttt_customer_value: string;
            ttt_sarsreimbursement: number | null;
            createdon: string;
        }

        let allInvoices: InvoiceRow[] = [];
        let nextLink: string | null = invoiceEndpoint;
        let pageCount = 0;

        while (nextLink && pageCount < 100) {
            pageCount++;
            const endpoint: string = nextLink.startsWith("http")
                ? nextLink.replace(/^.*\/api\/data\/v9\.2\//, "")
                : nextLink;
            const response = await dynamicsRequest<{ value: InvoiceRow[]; "@odata.nextLink"?: string }>(endpoint);
            if (response.value?.length) {
                allInvoices.push(...response.value);
            }
            nextLink = response["@odata.nextLink"] ?? null;
        }

        // De-duplicate: keep the highest reimbursement per contact
        const contactMap = new Map<string, InvoiceRow>();
        for (const row of allInvoices) {
            const cid = row._ttt_customer_value;
            if (!cid) continue;
            const existing = contactMap.get(cid);
            if (!existing || (row.ttt_sarsreimbursement ?? 0) > (existing.ttt_sarsreimbursement ?? 0)) {
                contactMap.set(cid, row);
            }
        }

        const contactIds = Array.from(contactMap.keys());
        if (contactIds.length === 0) return { contacts: [], totalCount: 0 };

        // Build additional contact-level filter conditions
        let extraFilter = "";
        if (resolvedArgs.filter) {
            extraFilter += ` and (${resolvedArgs.filter})`;
        }
        if (resolvedArgs.search) {
            const s = resolvedArgs.search.replace(/'/g, "''");
            extraFilter += ` and (contains(fullname,'${s}') or contains(emailaddress1,'${s}'))`;
        }
        if (resolvedArgs.clientType) {
            extraFilter += ` and riivo_clienttypenew eq ${resolvedArgs.clientType}`;
        }
        if (resolvedArgs.entityType !== undefined) {
            extraFilter += ` and riivo_clienttypeindbus eq ${resolvedArgs.entityType}`;
        }
        if (resolvedArgs.bank !== undefined) {
            extraFilter += ` and ttt_bank eq ${resolvedArgs.bank}`;
        }
        if (resolvedArgs.sourceCode && resolvedArgs.sourceCode.length > 0) {
            const values = resolvedArgs.sourceCode.map(String).join("','");
            extraFilter += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
        }
        if (resolvedArgs.province) {
            const prov = resolvedArgs.province.replace(/'/g, "''");
            extraFilter += ` and address1_stateorprovince eq '${prov}'`;
        }
        if (resolvedArgs.ageMin !== undefined) {
            extraFilter += ` and riivo_age ge ${resolvedArgs.ageMin}`;
        }
        if (resolvedArgs.ageMax !== undefined) {
            extraFilter += ` and riivo_age le ${resolvedArgs.ageMax}`;
        }
        if (resolvedArgs.ownerId) {
            extraFilter += ` and _ownerid_value eq '${resolvedArgs.ownerId}'`;
        }
        if (resolvedArgs.industryId) {
            extraFilter += ` and _riivo_industryid_value eq '${resolvedArgs.industryId}'`;
        }

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

        for (let i = 0; i < contactIds.length; i += 50) {
            const batch = contactIds.slice(i, i + 50);
            const idFilter = batch.map((id) => `contactid eq '${id}'`).join(" or ");
            const contactEndpoint = `contacts?$select=${CONTACT_SELECT_FIELDS}&$filter=statecode eq 0 and (${idFilter})${extraFilter}&$orderby=fullname asc`;
            const contactResponse = await dynamicsRequest<{ value: DynamicsContact[] }>(contactEndpoint);

            for (const c of contactResponse.value) {
                const invoiceRow = contactMap.get(c.contactid);
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
                    sarsReimbursement: invoiceRow?.ttt_sarsreimbursement ?? null,
                });
            }
        }

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
