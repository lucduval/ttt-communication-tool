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
    /** Client type (riivo_clienttypenew). */
    clientType?: string;
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
    let filterExpression = "statecode eq 0";

    if (filter.filter) {
        filterExpression += ` and (${filter.filter})`;
    }

    if (filter.search) {
        const searchTerm = escapeODataValue(filter.search);
        filterExpression += ` and (contains(fullname,'${searchTerm}') or contains(emailaddress1,'${searchTerm}'))`;
    }

    if (filter.clientType) {
        filterExpression += ` and riivo_clienttypenew eq '${filter.clientType}'`;
    }

    if (filter.entityType !== undefined) {
        filterExpression += ` and riivo_clienttypeindbus eq ${filter.entityType}`;
    }

    if (filter.bank !== undefined) {
        filterExpression += ` and ttt_bank eq ${filter.bank}`;
    }

    if (filter.sourceCode && filter.sourceCode.length > 0) {
        const values = filter.sourceCode.map(String).join("','");
        filterExpression += ` and Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_sourcecode',PropertyValues=['${values}'])`;
    }

    if (filter.province) {
        const prov = escapeODataValue(filter.province);
        filterExpression += ` and address1_stateorprovince eq '${prov}'`;
    }

    if (filter.geographicLocation !== undefined) {
        filterExpression += ` and riivo_geographiclocation eq ${filter.geographicLocation}`;
    }

    if (filter.ageMin !== undefined) {
        filterExpression += ` and riivo_age ge ${filter.ageMin}`;
    }

    if (filter.ageMax !== undefined) {
        filterExpression += ` and riivo_age le ${filter.ageMax}`;
    }

    if (filter.ownerId) {
        filterExpression += ` and _ownerid_value eq '${filter.ownerId}'`;
    }

    if (filter.industryId) {
        filterExpression += ` and _riivo_industryid_value eq '${filter.industryId}'`;
    }

    return filterExpression;
}
