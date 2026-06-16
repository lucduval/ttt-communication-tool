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
    /** Alphabetical name-range lower bound (fullname ge). Used for batch sending. */
    nameRangeStart?: string;
    /**
     * Alphabetical name-range upper bound. Emitted as fullname lt the letter
     * after nameRangeEnd, so the range is inclusive of the named letter. A value
     * of "Z" contributes no upper bound (the range extends to the end).
     */
    nameRangeEnd?: string;
}

/**
 * Escape a value destined for an OData single-quoted string literal.
 * Single quotes are doubled per the OData spec.
 */
export function escapeODataValue(value: string): string {
    return value.replace(/'/g, "''");
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

/** Options for {@link streamContacts}. */
interface StreamContactsOptions<T> extends StreamPagesOptions<T> {
    /** Columns to retrieve ($select). */
    select: string;
    /** Order clause; defaults to "fullname asc". */
    orderby?: string;
    /** Collection to query; defaults to "contacts". */
    entity?: string;
}

/**
 * Stream every contact matching a typed filter, page by page. The filter is built
 * here from the typed object so the owner scope (and every other clause) is always
 * applied — callers cannot pass a pre-built string that bypasses it.
 */
export async function streamContacts<T>(
    filter: ContactFilter,
    opts: StreamContactsOptions<T>
): Promise<void> {
    const entity = opts.entity ?? "contacts";
    const orderby = opts.orderby ?? "fullname asc";
    const filterExpression = buildContactFilter(filter);
    const initialEndpoint = `${entity}?$filter=${filterExpression}&$select=${opts.select}&$orderby=${orderby}`;
    await streamPages<T>(initialEndpoint, opts);
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
 * is always applied because the filter is built from the typed object here.
 */
export async function countContacts(
    filter: ContactFilter,
    opts: CountContactsOptions = {}
): Promise<number> {
    const request = opts.request ?? dynamicsRequest;
    const ceiling = opts.ceiling ?? 5000;
    const filterExpression = buildContactFilter(filter);

    const probeEndpoint = `contacts?$filter=${filterExpression}&$count=true&$top=1&$select=contactid`;
    const probe = await request<DynamicsPage<{ contactid: string }>>(probeEndpoint);
    const odataCount = probe["@odata.count"] ?? 0;
    if (odataCount < ceiling) {
        return odataCount;
    }

    // Count exceeded the ceiling — paginate to get the real number.
    let total = 0;
    await streamPages<{ contactid: string }>(
        `contacts?$filter=${filterExpression}&$select=contactid&$count=true`,
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
 * caller never assembles paging details itself. Returns the raw Dynamics page.
 */
export async function fetchContactsPage<T>(
    filter: ContactFilter,
    opts: FetchContactsPageOptions
): Promise<DynamicsPage<T>> {
    const request = opts.request ?? dynamicsRequest;
    let endpoint: string;
    if (opts.cursor) {
        endpoint = normalizeEndpoint(opts.cursor);
    } else {
        const parts = [
            `$select=${opts.select}`,
            `$filter=${buildContactFilter(filter)}`,
            `$orderby=${opts.orderby ?? "fullname asc"}`,
        ];
        if (opts.countOnly) {
            parts.push("$count=true");
            parts.push("$top=1");
        }
        endpoint = `contacts?${parts.join("&")}`;
    }
    return request<DynamicsPage<T>>(endpoint, {
        headers: { Prefer: `odata.include-annotations="*",odata.maxpagesize=${opts.pageSize}` },
    });
}
