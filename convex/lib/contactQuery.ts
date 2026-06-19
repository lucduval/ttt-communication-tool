/**
 * Contact Query module
 *
 * The single deep place that turns a typed set of campaign filters into a
 * Dynamics contact query. This module owns the pure, contact-level
 * filter-builder: given a typed filter object it returns the OData filter
 * expression. All value-escaping (apostrophes / special characters) lives
 * here so callers never hand-roll a filter string.
 *
 * On top of the pure filter-builder, the module owns the *execution* of contact
 * queries: streaming, counting, and single-page fetches. Those operations handle
 * pagination cursors, page-size control, base-URL normalization, and
 * retry-with-backoff internally, so callers never reconstruct Dynamics paging
 * details and — because every operation builds its own filter from the typed
 * object — can never silently skip owner scoping. The module talks to Dynamics
 * through the low-level request primitive from the auth module directly.
 */

import { dynamicsRequest } from "./dynamics_auth";

/**
 * Typed contact-level filter object. Each field maps to a single OData clause
 * appended to the base "active contacts only" filter.
 */
export interface ContactFilter {
    /** Raw passthrough OData expression, wrapped in parentheses when present. */
    filter?: string;
    /** Free-text search across fullname / emailaddress1. */
    search?: string;
    /** Client type multi-select option codes (riivo_clienttypenew). */
    clientType?: number[];
    /** Entity type option set (riivo_clienttypeindbus). */
    entityType?: number;
    /** Bank option set (ttt_bank). */
    bank?: number;
    /** Source code multi-select option codes (riivo_sourcecode). */
    sourceCode?: number[];
    /** Province / state (address1_stateorprovince). */
    province?: string;
    /** SA Provinces option set (riivo_geographiclocation). */
    geographicLocation?: number;
    /** Minimum age (riivo_age ge). */
    ageMin?: number;
    /** Maximum age (riivo_age le). */
    ageMax?: number;
    /** Owner scope (_ownerid_value). */
    ownerId?: string;
    /** Industry scope (_riivo_industryid_value). */
    industryId?: string;
    /**
     * Marketing-consent type. Each value maps to a single boolean-marketing flag
     * (riivo_taxmarketing / riivo_accountingmarketing / riivo_insurancemarketing)
     * emitted as `… eq true`. Absent means no marketing clause (the "all" case).
     * The riivo_*marketing field names live only here — callers select the typed
     * value, never the field name.
     */
    marketingType?: "tax" | "accounting" | "insurance";
    /**
     * WhatsApp opt-in flag (riivo_whatsappoptinout), tri-state: `true` / `false`
     * emit the matching equality; `undefined` (the UI "all" case) emits no clause.
     * The field name lives only inside Contact Query — callers select the typed
     * boolean, never the field name.
     */
    whatsappOptIn?: boolean;
    /**
     * Email-enabled flag (icon_sendemailclientnotifications), tri-state: `true` /
     * `false` emit the matching equality; `undefined` (the UI "all" case) emits no
     * clause. The field name lives only inside Contact Query.
     */
    emailEnabled?: boolean;
    /** Alphabetical name-range lower bound (fullname ge). Used for batch sending. */
    nameRangeStart?: string;
    /**
     * Alphabetical name-range upper bound. Emitted as fullname lt the letter
     * after nameRangeEnd, so the range is inclusive of the named letter. A value
     * of "Z" contributes no upper bound (the range extends to the end).
     */
    nameRangeEnd?: string;
    /**
     * Restrict the query to a specific set of contact ids. This is an
     * execution-level *streaming* dimension, not a single OData clause: when set,
     * {@link streamContacts} owns the `contactid eq` encoding and fans the ids out
     * over the OData OR-ceiling in chunks (see {@link CONTACT_ID_OR_CEILING}),
     * paginating each chunk and re-applying every other clause (owner scope, client
     * type, etc.) to it. The clause builders deliberately ignore this field — it can
     * never be flattened into one filter expression. Specialised audiences use this
     * to re-query their scanned ids through Contact Query instead of hand-building
     * id clauses.
     *
     * Ordering note: results stream per chunk. `$orderby` applies within each chunk,
     * but there is no global ordering across chunks.
     */
    contactIds?: string[];
}

/**
 * Escape a value destined for an OData single-quoted string literal.
 * Single quotes are doubled per the OData spec.
 */
export function escapeODataValue(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Maximum number of `contactid eq` terms ORed into a single chunk's filter. The
 * `contactIds` dimension fans out over this ceiling so each chunk stays under the
 * OData query limit. Conservative to keep request URLs well within the Dynamics
 * length limit even alongside the rest of the filter clauses.
 */
export const CONTACT_ID_OR_CEILING = 50;

/**
 * Build the `contactid eq '…' or …` disjunction for a single chunk of ids. Each
 * id is escaped for an OData single-quoted literal. Only ever applied to a chunk
 * sized under {@link CONTACT_ID_OR_CEILING} — never the full id set.
 */
export function buildContactIdClause(ids: string[]): string {
    return ids.map((id) => `contactid eq '${escapeODataValue(id)}'`).join(" or ");
}

/**
 * Build the contact-level OData filter expression for a typed filter object.
 *
 * The expression always begins with the active-only base ("statecode eq 0")
 * and appends one clause per populated filter field, in a fixed order.
 */
export function buildContactFilter(filter: ContactFilter): string {
    return "statecode eq 0" + buildContactFilterClauses(filter);
}

/**
 * Map each marketing-consent type to its Dynamics boolean-marketing flag. The
 * `riivo_*marketing` field names live only here — Contact Query owns them so no
 * caller hand-builds a marketing clause.
 */
const MARKETING_TYPE_FIELD: Record<NonNullable<ContactFilter["marketingType"]>, string> = {
    tax: "riivo_taxmarketing",
    accounting: "riivo_accountingmarketing",
    insurance: "riivo_insurancemarketing",
};

/**
 * Build only the appended clauses for a typed filter object — the same clauses
 * buildContactFilter adds after the active-only base, in the same fixed order,
 * but without the leading "statecode eq 0".
 *
 * This is the "extra filter" form used by two-step audience queries that resolve
 * a related entity first and then re-query contacts with their own id-batch base
 * (e.g. tax-return / ITA34 / bad-debt sends). They append these clauses to their
 * own base so the contact-level filtering stays identical to a standard query.
 * Returns "" when no fields are populated.
 */
export function buildContactFilterClauses(filter: ContactFilter): string {
    let clauses = "";

    if (filter.filter) {
        clauses += ` and (${filter.filter})`;
    }

    if (filter.search) {
        const searchTerm = escapeODataValue(filter.search);
        clauses += ` and (contains(fullname,'${searchTerm}') or contains(emailaddress1,'${searchTerm}'))`;
    }

    if (filter.clientType && filter.clientType.length > 0) {
        const values = filter.clientType.map(String).join("','");
        clauses += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['${values}'])`;
    }

    if (filter.entityType !== undefined) {
        clauses += ` and riivo_clienttypeindbus eq ${filter.entityType}`;
    }

    if (filter.bank !== undefined) {
        clauses += ` and ttt_bank eq ${filter.bank}`;
    }

    if (filter.sourceCode && filter.sourceCode.length > 0) {
        const values = filter.sourceCode.map(String).join("','");
        clauses += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
    }

    if (filter.province) {
        const prov = escapeODataValue(filter.province);
        clauses += ` and address1_stateorprovince eq '${prov}'`;
    }

    if (filter.geographicLocation !== undefined) {
        clauses += ` and riivo_geographiclocation eq ${filter.geographicLocation}`;
    }

    if (filter.ageMin !== undefined) {
        clauses += ` and riivo_age ge ${filter.ageMin}`;
    }

    if (filter.ageMax !== undefined) {
        clauses += ` and riivo_age le ${filter.ageMax}`;
    }

    if (filter.ownerId) {
        clauses += ` and _ownerid_value eq '${filter.ownerId}'`;
    }

    if (filter.industryId) {
        clauses += ` and _riivo_industryid_value eq '${filter.industryId}'`;
    }

    if (filter.marketingType) {
        clauses += ` and ${MARKETING_TYPE_FIELD[filter.marketingType]} eq true`;
    }

    // Opt-in flags are tri-state: gate on `!== undefined` so an explicit `false`
    // still emits its clause (a plain truthiness check would drop it).
    if (filter.whatsappOptIn !== undefined) {
        clauses += ` and riivo_whatsappoptinout eq ${filter.whatsappOptIn}`;
    }

    if (filter.emailEnabled !== undefined) {
        clauses += ` and icon_sendemailclientnotifications eq ${filter.emailEnabled}`;
    }

    if (filter.nameRangeStart) {
        clauses += ` and fullname ge '${filter.nameRangeStart}'`;
    }

    if (filter.nameRangeEnd && filter.nameRangeEnd !== "Z") {
        const nextChar = String.fromCharCode(filter.nameRangeEnd.charCodeAt(0) + 1);
        clauses += ` and fullname lt '${nextChar}'`;
    }

    return clauses;
}

// ---- Query execution: streaming, counting, paging ----

/**
 * A minimal Dynamics collection page: the row array plus the optional paging and
 * count annotations the module needs to drive pagination.
 */
export interface DynamicsPage<T> {
    value?: T[];
    "@odata.nextLink"?: string;
    "@odata.count"?: number;
}

/**
 * The low-level Dynamics request primitive. Mirrors the signature of
 * dynamics_auth's dynamicsRequest so the real implementation is the default and
 * tests can inject a faked boundary.
 */
export type DynamicsRequestFn = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

/** Default backoff sleep — exponential delays of 1s, 2s, 4s between retries. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip the Dynamics Web API base prefix from a full `@odata.nextLink` so it can
 * be handed back to the request primitive as a relative endpoint. Endpoints that
 * are already relative pass through unchanged.
 */
export function normalizeEndpoint(endpoint: string): string {
    return endpoint.replace(/^.*\/api\/data\/v9\.2\//, "");
}

/** Options common to the paging request helpers. */
interface RequestExecutionOptions {
    /** Injected request primitive; defaults to the real dynamicsRequest. */
    request?: DynamicsRequestFn;
    /** Injected backoff sleep; defaults to real timers. */
    sleep?: (ms: number) => Promise<void>;
    /** Number of attempts per page before giving up. Defaults to 3. */
    maxRetries?: number;
}

/**
 * Issue a single page request, retrying transient failures with exponential
 * backoff. Throws the last error once retries are exhausted.
 */
async function requestPageWithRetry<T>(
    endpoint: string,
    options: RequestInit,
    request: DynamicsRequestFn,
    sleep: (ms: number) => Promise<void>,
    maxRetries: number
): Promise<DynamicsPage<T>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await request<DynamicsPage<T>>(endpoint, options);
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s, ...
                await sleep(1000 * Math.pow(2, attempt - 1));
            }
        }
    }
    throw lastError;
}

/** Options for {@link streamPages}. */
interface StreamPagesOptions<T> extends RequestExecutionOptions {
    /** Page size via the Prefer: odata.maxpagesize header. Omit for the server default. */
    pageSize?: number;
    /** Safety cap on the number of pages followed. Defaults to 1000. */
    maxPages?: number;
    /** Invoked with each non-empty page's rows, in order. */
    onPage: (rows: T[]) => Promise<void> | void;
}

/**
 * Page through a Dynamics collection endpoint, delivering each page's rows to
 * `onPage`. Owns cursor extraction, base-URL normalization, optional page-size
 * control, and retry/backoff, so callers never touch `@odata.nextLink` directly.
 */
export async function streamPages<T>(
    initialEndpoint: string,
    opts: StreamPagesOptions<T>
): Promise<void> {
    const request = opts.request ?? dynamicsRequest;
    const sleep = opts.sleep ?? defaultSleep;
    const maxRetries = opts.maxRetries ?? 3;
    const maxPages = opts.maxPages ?? 1000;
    const options: RequestInit = opts.pageSize
        ? { headers: { Prefer: `odata.include-annotations="*",odata.maxpagesize=${opts.pageSize}` } }
        : {};

    let nextLink: string | null = initialEndpoint;
    let pageCount = 0;
    while (nextLink && pageCount < maxPages) {
        pageCount++;
        const endpoint = normalizeEndpoint(nextLink);
        const page = await requestPageWithRetry<T>(endpoint, options, request, sleep, maxRetries);
        const rows = page.value ?? [];
        if (rows.length > 0) {
            await opts.onPage(rows);
        }
        nextLink = page["@odata.nextLink"] ?? null;
    }
}

// ---- Entity-agnostic execution core ----
//
// stream / count / fetch-page accept a prebuilt filter expression plus the
// entity, select, order, and id-field, so any entity (contacts, leads, …) can
// drive the same paging / retry / count engine. The contact operations below
// are thin facades that build the contact filter and call into these.

/** Options for {@link streamEntity}. */
export interface StreamEntityOptions<T> extends StreamPagesOptions<T> {
    /** Collection to query (e.g. "contacts", "leads"). */
    entity: string;
    /** Columns to retrieve ($select). */
    select: string;
    /** Order clause ($orderby). */
    orderby: string;
}

/**
 * Stream every row of an entity matching a prebuilt filter expression, page by
 * page. Owns cursor extraction, normalization, page-size control, and retry via
 * {@link streamPages}; entity-agnostic so siblings reuse it without duplicating
 * paging.
 */
export async function streamEntity<T>(
    filterExpression: string,
    opts: StreamEntityOptions<T>
): Promise<void> {
    const initialEndpoint = `${opts.entity}?$filter=${filterExpression}&$select=${opts.select}&$orderby=${opts.orderby}`;
    await streamPages<T>(initialEndpoint, opts);
}

/** Options for {@link countEntity}. */
export interface CountEntityOptions extends RequestExecutionOptions {
    /** Collection to query (e.g. "contacts", "leads"). */
    entity: string;
    /** Primary-key column used for the probe and id-pagination pass. */
    idField: string;
    /**
     * The `@odata.count` ceiling above which Dynamics caps the reported count.
     * Hitting it triggers an id pagination pass for the true total. Defaults to 5000.
     */
    ceiling?: number;
    /** Safety cap on pages followed during the pagination pass. Defaults to 200. */
    maxPages?: number;
}

/**
 * Count rows of an entity matching a prebuilt filter expression. Uses
 * `@odata.count` when it is below the ceiling; otherwise paginates ids to recover
 * the true total. Entity-agnostic so the count-fallback engine is shared.
 */
export async function countEntity(
    filterExpression: string,
    opts: CountEntityOptions
): Promise<number> {
    const request = opts.request ?? dynamicsRequest;
    const ceiling = opts.ceiling ?? 5000;
    const { entity, idField } = opts;

    const probeEndpoint = `${entity}?$filter=${filterExpression}&$count=true&$top=1&$select=${idField}`;
    const probe = await request<DynamicsPage<Record<string, string>>>(probeEndpoint);
    const odataCount = probe["@odata.count"] ?? 0;
    if (odataCount < ceiling) {
        return odataCount;
    }

    // Count exceeded the ceiling — paginate to get the real number.
    let total = 0;
    await streamPages<Record<string, string>>(
        `${entity}?$filter=${filterExpression}&$select=${idField}&$count=true`,
        {
            request: opts.request,
            sleep: opts.sleep,
            maxRetries: opts.maxRetries,
            maxPages: opts.maxPages ?? 200,
            onPage: (rows) => {
                total += rows.length;
            },
        }
    );
    return total;
}

/** Options for {@link fetchEntityPage}. */
export interface FetchEntityPageOptions extends RequestExecutionOptions {
    /** Collection to query (e.g. "contacts", "leads"). */
    entity: string;
    /** Columns to retrieve ($select). */
    select: string;
    /** Order clause ($orderby). */
    orderby: string;
    /** Page size via the Prefer: odata.maxpagesize header. */
    pageSize: number;
    /** A nextLink/skip token from a prior page; followed verbatim after normalization. */
    cursor?: string;
    /** Request `@odata.count` for the (capped) total. */
    countOnly?: boolean;
}

/**
 * Fetch a single page of an entity for a client-driven recipient list. Builds the
 * request (or follows a normalized cursor) and applies the page-size header.
 * Entity-agnostic; returns the raw Dynamics page.
 */
export async function fetchEntityPage<T>(
    filterExpression: string,
    opts: FetchEntityPageOptions
): Promise<DynamicsPage<T>> {
    const request = opts.request ?? dynamicsRequest;
    let endpoint: string;
    if (opts.cursor) {
        endpoint = normalizeEndpoint(opts.cursor);
    } else {
        const parts = [
            `$select=${opts.select}`,
            `$filter=${filterExpression}`,
            `$orderby=${opts.orderby}`,
        ];
        if (opts.countOnly) {
            parts.push("$count=true");
            parts.push("$top=1");
        }
        endpoint = `${opts.entity}?${parts.join("&")}`;
    }
    return request<DynamicsPage<T>>(endpoint, {
        headers: { Prefer: `odata.include-annotations="*",odata.maxpagesize=${opts.pageSize}` },
    });
}

// ---- Contact facades over the entity-agnostic core ----

/** Options for {@link streamContacts}. */
interface StreamContactsOptions<T> extends StreamPagesOptions<T> {
    /** Columns to retrieve ($select). */
    select: string;
    /** Order clause; defaults to "fullname asc". */
    orderby?: string;
    /** Collection to query; defaults to "contacts". */
    entity?: string;
    /** Per-chunk id ceiling for the contactIds dimension; defaults to {@link CONTACT_ID_OR_CEILING}. */
    contactIdChunkSize?: number;
}

/**
 * Stream every contact matching a typed filter, page by page. The filter is built
 * here from the typed object so the owner scope (and every other clause) is always
 * applied — callers cannot pass a pre-built string that bypasses it. A thin facade
 * over {@link streamEntity}.
 *
 * When the filter carries a `contactIds` set, the stream is restricted to those
 * ids: the ids are chunked under {@link CONTACT_ID_OR_CEILING} and each chunk runs
 * as its own query (with every other clause re-applied), paginated independently.
 * Rows stream per chunk in chunk order — `$orderby` is honoured within a chunk but
 * not across chunks. An empty `contactIds` set yields nothing and issues no request.
 */
export async function streamContacts<T>(
    filter: ContactFilter,
    opts: StreamContactsOptions<T>
): Promise<void> {
    const entity = opts.entity ?? "contacts";
    const orderby = opts.orderby ?? "fullname asc";
    const base = buildContactFilter(filter);

    if (filter.contactIds !== undefined) {
        const chunkSize = opts.contactIdChunkSize ?? CONTACT_ID_OR_CEILING;
        for (let i = 0; i < filter.contactIds.length; i += chunkSize) {
            const idChunk = filter.contactIds.slice(i, i + chunkSize);
            const expression = `${base} and (${buildContactIdClause(idChunk)})`;
            await streamEntity<T>(expression, { ...opts, entity, select: opts.select, orderby });
        }
        return;
    }

    await streamEntity<T>(base, { ...opts, entity, select: opts.select, orderby });
}

/** Options for {@link countContacts}. */
interface CountContactsOptions extends RequestExecutionOptions {
    /**
     * The `@odata.count` ceiling above which Dynamics caps the reported count.
     * Hitting it triggers a contactid pagination pass for the true total.
     * Defaults to 5000.
     */
    ceiling?: number;
    /** Safety cap on pages followed during the pagination pass. Defaults to 200. */
    maxPages?: number;
}

/**
 * Count contacts matching a typed filter. Uses `@odata.count` when it is below the
 * ceiling; otherwise paginates contactids to recover the true total. Owner scope
 * is always applied because the filter is built from the typed object here. A thin
 * facade over {@link countEntity}.
 */
export async function countContacts(
    filter: ContactFilter,
    opts: CountContactsOptions = {}
): Promise<number> {
    return countEntity(buildContactFilter(filter), {
        ...opts,
        entity: "contacts",
        idField: "contactid",
    });
}

/** Options for {@link fetchContactsPage}. */
interface FetchContactsPageOptions extends RequestExecutionOptions {
    /** Columns to retrieve ($select). */
    select: string;
    /** Order clause; defaults to "fullname asc". */
    orderby?: string;
    /** Page size via the Prefer: odata.maxpagesize header. */
    pageSize: number;
    /** A nextLink/skip token from a prior page; followed verbatim after normalization. */
    cursor?: string;
    /** Request `@odata.count` for the (capped) total. */
    countOnly?: boolean;
}

/**
 * Fetch a single page of contacts for the client-driven recipient list. Builds the
 * request (or follows a normalized cursor) and applies the page-size header so the
 * caller never assembles paging details itself. Returns the raw Dynamics page. A
 * thin facade over {@link fetchEntityPage}.
 */
export async function fetchContactsPage<T>(
    filter: ContactFilter,
    opts: FetchContactsPageOptions
): Promise<DynamicsPage<T>> {
    return fetchEntityPage<T>(buildContactFilter(filter), {
        ...opts,
        entity: "contacts",
        select: opts.select,
        orderby: opts.orderby ?? "fullname asc",
        pageSize: opts.pageSize,
    });
}
