
import { dynamicsRequest } from "../actions/dynamics";

interface SimpleContact {
    contactid: string;
    fullname: string;
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
    clientType?: number;
    entityType?: number;
    bank?: number;
    sourceCode?: string | string[];
    province?: string;
    ageMin?: number;
    ageMax?: number;
    ownerId?: string;
    industryId?: string;
}

/**
 * Fetch contacts matching filters from Dynamics and process them in chunks
 */
export async function fetchMatchingContacts(
    filters: CampaignFilters,
    onChunk: (contacts: ShimmedContact[]) => Promise<void>
) {
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
        ownerId,
        industryId
    } = filters;

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
        // Handle array or string sourceCode
        const values = Array.isArray(sourceCode) ? sourceCode.map(String).join("','") : String(sourceCode);
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

    while (nextLink && pageCount < MAX_PAGES) {
        pageCount++;
        if (nextLink.startsWith("http")) {
            nextLink = nextLink.replace(/^.*\/api\/data\/v9\.2\//, "");
        }

        try {
            const response: SimpleContactsResponse = await dynamicsRequest<SimpleContactsResponse>(nextLink);

            if (response.value && response.value.length > 0) {
                const chunk = response.value.map((contact) => ({
                    id: contact.contactid,
                    fullName: contact.fullname,
                    email: contact.emailaddress1,
                    phone: contact.mobilephone,
                    internationalPhone: (contact as any).icon_formattedmobilenumber || null,
                    referralCode: contact.riivo_referralcode || null,
                }));

                await onChunk(chunk);
            }

            nextLink = response["@odata.nextLink"] || null;
        } catch (error) {
            console.error(`Error fetching contacts page ${pageCount}:`, error);
            // Decide whether to continue or abort. For now, we'll abort to avoid infinite loops or partial data states being unknown
            throw error;
        }
    }
}
