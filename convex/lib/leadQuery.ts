/**
 * Lead Query module
 *
 * A sibling to the Contact Query module: the single deep place that turns a
 * typed set of lead filters into a Dynamics lead query. Leads have their own
 * filter vocabulary (status, opt-ins) and their own field names for the four
 * concepts they share with contacts (search, province, owner, industry), so
 * this module owns a typed {@link LeadFilter} and a lead-specific filter
 * builder. All value-escaping (apostrophes / special characters) reuses the
 * shared helper from Contact Query, so the OData dialect stays owned in one
 * place — callers never hand-roll a filter string.
 *
 * On top of the pure filter-builder, the module owns the *execution* of lead
 * queries: streaming, counting, and single-page fetches. These are thin facades
 * over the entity-agnostic execution core in Contact Query, so leads reuse the
 * same pagination, retry, and count-fallback engine as contacts. Because every
 * operation builds its own filter from the typed object, owner scoping can never
 * be silently skipped.
 */

import {
    escapeODataValue,
    streamEntity,
    countEntity,
    fetchEntityPage,
    type StreamEntityOptions,
    type CountEntityOptions,
    type FetchEntityPageOptions,
    type DynamicsPage,
} from "./contactQuery";

/**
 * Typed lead-level filter object. Each field maps to a single OData clause
 * appended to the status base, in lead's own field names.
 */
export interface LeadFilter {
    /**
     * Lead status. "active" → statecode eq 0, "inactive" → statecode eq 1,
     * "all" (or absent) → an always-true placeholder so other clauses still
     * chain with AND.
     */
    status?: string;
    /** Free-text search across new_name / ttt_email. */
    search?: string;
    /** Province / state (riivo_province). */
    province?: string;
    /** Email opt-in flag (riivo_emailoptin). */
    emailOptIn?: boolean;
    /** WhatsApp opt-in flag (riivo_whatsappoptin). */
    whatsappOptIn?: boolean;
    /** Owner scope (_ownerid_value). */
    ownerId?: string;
    /** Industry scope (_riivo_industry_lookup_value). */
    industryId?: string;
}

/**
 * Build the lead-level OData filter expression for a typed filter object.
 *
 * The expression always begins with a status base and appends one clause per
 * populated filter field, in a fixed order. Mirrors the behaviour of the
 * hand-rolled lead filter builder it replaces — this is consolidation, not a
 * behaviour change.
 */
export function buildLeadFilter(filter: LeadFilter): string {
    let expression: string;
    if (filter.status === "active") {
        expression = "statecode eq 0";
    } else if (filter.status === "inactive") {
        expression = "statecode eq 1";
    } else {
        // "all" or absent — no statecode filter, but keep an always-true
        // placeholder so the subsequent clauses still chain with AND.
        expression = "statecode ne -1";
    }

    if (filter.search) {
        const searchTerm = escapeODataValue(filter.search);
        expression += ` and (contains(new_name,'${searchTerm}') or contains(ttt_email,'${searchTerm}'))`;
    }

    if (filter.province) {
        const prov = escapeODataValue(filter.province);
        expression += ` and riivo_province eq '${prov}'`;
    }

    if (filter.emailOptIn === true) {
        expression += ` and riivo_emailoptin eq true`;
    } else if (filter.emailOptIn === false) {
        expression += ` and riivo_emailoptin eq false`;
    }

    if (filter.whatsappOptIn === true) {
        expression += ` and riivo_whatsappoptin eq true`;
    } else if (filter.whatsappOptIn === false) {
        expression += ` and riivo_whatsappoptin eq false`;
    }

    if (filter.ownerId) {
        expression += ` and _ownerid_value eq '${filter.ownerId}'`;
    }

    if (filter.industryId) {
        expression += ` and _riivo_industry_lookup_value eq '${filter.industryId}'`;
    }

    return expression;
}

// ---- Lead facades over the entity-agnostic core ----

/** The Dynamics collection for leads. */
const LEAD_ENTITY = "new_leads";
/** The lead primary-key column. */
const LEAD_ID_FIELD = "new_leadid";
/** Default order for lead queries. */
const LEAD_DEFAULT_ORDERBY = "new_name asc";

/** Options for {@link streamLeads}. Entity and order default to lead's own. */
export interface StreamLeadsOptions<T> extends Omit<StreamEntityOptions<T>, "entity" | "orderby"> {
    /** Order clause; defaults to "new_name asc". */
    orderby?: string;
    /** Collection to query; defaults to "new_leads". */
    entity?: string;
}

/**
 * Stream every lead matching a typed filter, page by page. The filter is built
 * here from the typed object so the owner scope (and every other clause) is
 * always applied — callers cannot pass a pre-built string that bypasses it. A
 * thin facade over {@link streamEntity}.
 */
export async function streamLeads<T>(
    filter: LeadFilter,
    opts: StreamLeadsOptions<T>
): Promise<void> {
    await streamEntity<T>(buildLeadFilter(filter), {
        ...opts,
        entity: opts.entity ?? LEAD_ENTITY,
        select: opts.select,
        orderby: opts.orderby ?? LEAD_DEFAULT_ORDERBY,
    });
}

/** Options for {@link countLeads}. Entity and id-field are lead's own. */
export type CountLeadsOptions = Omit<CountEntityOptions, "entity" | "idField">;

/**
 * Count leads matching a typed filter. Uses `@odata.count` when it is below the
 * ceiling; otherwise paginates lead ids to recover the true total. Owner scope
 * is always applied because the filter is built from the typed object here. A
 * thin facade over {@link countEntity}.
 */
export async function countLeads(
    filter: LeadFilter,
    opts: CountLeadsOptions = {}
): Promise<number> {
    return countEntity(buildLeadFilter(filter), {
        ...opts,
        entity: LEAD_ENTITY,
        idField: LEAD_ID_FIELD,
    });
}

/** Options for {@link fetchLeadsPage}. Entity and order default to lead's own. */
export interface FetchLeadsPageOptions extends Omit<FetchEntityPageOptions, "entity" | "orderby"> {
    /** Order clause; defaults to "new_name asc". */
    orderby?: string;
}

/**
 * Fetch a single page of leads for the client-driven recipient list. Builds the
 * request (or follows a normalized cursor) and applies the page-size header so
 * the caller never assembles paging details itself. Returns the raw Dynamics
 * page. A thin facade over {@link fetchEntityPage}.
 */
export async function fetchLeadsPage<T>(
    filter: LeadFilter,
    opts: FetchLeadsPageOptions
): Promise<DynamicsPage<T>> {
    return fetchEntityPage<T>(buildLeadFilter(filter), {
        ...opts,
        entity: LEAD_ENTITY,
        select: opts.select,
        orderby: opts.orderby ?? LEAD_DEFAULT_ORDERBY,
        pageSize: opts.pageSize,
    });
}
