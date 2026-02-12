"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { dynamicsRequest } from "../lib/dynamics_auth";
export { dynamicsRequest };

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

            ownerId,
            industryId
        } = args;

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

        // Pagination - offset based
        if (skip !== undefined && skip > 0) {
            queryParts.push(`$skip=${skip}`);
        }
        queryParts.push(`$top=${top}`);

        // Include count
        if (countOnly) {
            queryParts.push("$count=true");
            // For count only, just get 1 record
            queryParts.length = queryParts.length - 1; // Remove $top
            queryParts.push("$top=1");
        }

        // Build the endpoint
        let endpoint = `contacts?${queryParts.join("&")}`;

        // If we have a skipToken, use it for pagination
        if (skipToken) {
            endpoint = skipToken.replace(/^.*\/api\/data\/v9\.2\//, "");
        }

        const response = await dynamicsRequest<ContactsResponse>(endpoint);

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
        const {
            ownerId,
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
        const {
            ownerId,
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
    args: {},
    handler: async (ctx) => {
        // Fetch active users, excluding system accounts (starting with #)
        // Note: # must be encoded as %23 to avoid being interpreted as a URL fragment
        const endpoint = `systemusers?$select=systemuserid,fullname&$filter=isdisabled eq false and not startswith(fullname,'%23')&$orderby=fullname asc`;

        interface DynamicsUser {
            systemuserid: string;
            fullname: string;
        }

        interface UsersResponse {
            value: DynamicsUser[];
        }

        const response = await dynamicsRequest<UsersResponse>(endpoint);

        return response.value.map(user => ({
            id: user.systemuserid,
            name: user.fullname,
        }));
    },
});

/**
 * Fetch industries from Dynamics
 */
export const fetchIndustries = action({
    args: {},
    handler: async (ctx) => {
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
