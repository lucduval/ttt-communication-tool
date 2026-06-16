/**
 * Contact Query module
 *
 * The single deep place that turns a typed set of campaign filters into a
 * Dynamics contact query. This module owns the pure, contact-level
 * filter-builder: given a typed filter object it returns the OData filter
 * expression. All value-escaping (apostrophes / special characters) lives
 * here so callers never hand-roll a filter string.
 */

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
