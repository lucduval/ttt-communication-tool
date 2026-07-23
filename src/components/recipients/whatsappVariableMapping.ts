/**
 * WhatsApp variable → column mapping — pure authoring core (PRD
 * prd-bad-debt-excel-campaign.md / PRD #84, issue #86).
 *
 * Meta template variables are **positional** (`{{1}} {{2}} {{3}}` plus a button
 * variable), supplied in order — unlike the email path's free-text `{column}`
 * matching, the binding of each position to an uploaded column must be stated
 * *explicitly*. This module is the pure core the recipients-step UI is a thin
 * shell over: it turns a template + the uploaded column headers into
 *
 *   1. {@link templateVariableFields} — the ordered list of variables the
 *      operator must map, each with a **human-readable label** derived from the
 *      template's own default logical variable names (`{{1}}` → "First name")
 *      rather than a bare positional token;
 *   2. {@link guessVariableMapping} — a pre-filled variable→header guess so a
 *      conventionally-headed export needs little or no adjustment; and
 *   3. {@link validateVariableMapping} — a check that *every* variable (body
 *      positions **and** the button/payment-link variable) has a column, naming
 *      the specific ones still unmapped so the operator is warned before a send
 *      would silently render blank `{{1}} {{2}} {{3}}`.
 *
 * The mapping's logical keys are exactly the names the send path already
 * consumes (`resolveRowVariables` in `convex/lib/whatsapp.ts`): the positional
 * body names (`"1"/"2"/"3"`) plus each dynamic button URL variable (e.g.
 * `"payment_link"`). Values are uploaded column headers. Everything here is pure
 * — no React, no Convex — so the authoring decisions are the test surface, as for
 * the column-role core it lives beside.
 */

import type { DetectedColumn } from "./extractContactIds";
import { resolveRowVariables } from "../../../convex/lib/whatsapp";

/**
 * The subset of a WhatsApp template record this core reads. Kept structural (not
 * the Convex `Doc`) so the helper stays pure and unit-testable without Convex.
 */
export interface WhatsAppTemplateShape {
    /** Positional body variables, in order — e.g. `["1", "2", "3"]`. */
    variables: string[];
    /**
     * JSON `{ variableName: defaultColumn }` map documenting the template's
     * intended column per variable (the seed templates' `DEFAULT_MAPPINGS`). Used
     * to derive each variable's human label and to seed the guess. Absent/malformed
     * → labels fall back to the variable name.
     */
    variableMappings?: string | null;
    /** Logical variable whose value fills the dynamic "Pay now" URL button suffix. */
    buttonUrlVariable?: string | null;
    /** A second dynamic URL button variable, if the template has one. */
    button2UrlVariable?: string | null;
}

/** One template variable the operator must bind to an uploaded column. */
export interface TemplateVariableField {
    /**
     * Logical variable name — the mapping key the send path reads. A positional
     * body variable (`"1"/"2"/"3"`) or a button URL variable (e.g. `"payment_link"`).
     */
    name: string;
    /** Whether this variable sits in the message body or on a URL button. */
    kind: "body" | "button";
    /**
     * The positional token for a body variable (`"1"/"2"/"3"`), so the UI can show
     * `{{1}}`; `null` for a button variable (rendered by label alone).
     */
    position: string | null;
    /**
     * The template's default column for this variable (from `variableMappings`, or
     * the variable name when none). What the guess matches uploaded headers against.
     */
    defaultColumn: string;
    /**
     * Human-readable label derived from {@link defaultColumn} — e.g. `first_name`
     * → "First name", `payment_link` → "Payment link" — so the operator maps
     * against a real-world meaning, not a bare `{{n}}`.
     */
    label: string;
}

export interface VariableMappingValidation {
    /** True when every field has a (present) column mapped. */
    complete: boolean;
    /** The fields with no column mapped (or a column not in the upload), in field order. */
    unmapped: TemplateVariableField[];
}

/** Parse the template's default `variableMappings` JSON, tolerating absence/garbage. */
function parseDefaultMappings(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof val === "string") out[k] = val;
        }
        return out;
    } catch {
        return {};
    }
}

/**
 * Humanise a logical column name for display: `first_name` → "First name",
 * `amount_formatted` → "Amount formatted", `payment_link` → "Payment link".
 * Underscores/dashes become spaces; the whole label is lower-cased with only the
 * first letter capitalised (proper-noun casing is not something we can infer).
 */
function humanise(name: string): string {
    const words = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (words === "") return name;
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The ordered list of variables the operator must map for a template: every
 * positional body variable, then each dynamic URL button variable. Each carries a
 * human label derived from the template's own default logical names, so the UI
 * shows "`{{1}}` — First name" / "Payment link" rather than an opaque token.
 */
export function templateVariableFields(
    template: WhatsAppTemplateShape,
): TemplateVariableField[] {
    const defaults = parseDefaultMappings(template.variableMappings);
    const field = (name: string, kind: "body" | "button"): TemplateVariableField => {
        const defaultColumn = defaults[name] ?? name;
        return {
            name,
            kind,
            // Positional body variables render as `{{n}}`; anything else has no token.
            position: kind === "body" && /^\d+$/.test(name) ? name : null,
            defaultColumn,
            label: humanise(defaultColumn),
        };
    };

    const body = template.variables.map((name) => field(name, "body"));
    const buttons = [template.buttonUrlVariable, template.button2UrlVariable]
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((name) => field(name, "button"));

    return [...body, ...buttons];
}

/** Normalise a header/name for matching: lower-case, strip non-alphanumerics. */
function normaliseForMatch(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Guess a variable→header mapping from the column headers. For each field we look
 * for the column that best matches its default column name (normalised): an exact
 * normalised match wins, then a substring match either way (`first_name` ↔
 * "First Name" ↔ "firstname"). A positional body variable also matches a column
 * literally named after its position (`"1"`), mirroring the send path's by-name
 * fallback. A field with no plausible column is left unmapped (empty) — the
 * operator (and {@link validateVariableMapping}) then sees exactly what is missing.
 */
export function guessVariableMapping(
    fields: readonly TemplateVariableField[],
    columns: readonly DetectedColumn[],
): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const f of fields) {
        const targets = [normaliseForMatch(f.defaultColumn)];
        if (f.position) targets.push(normaliseForMatch(f.position));

        // Exact normalised match first, across every target, before falling back
        // to a looser substring match — so "amount" never pre-empts "amount_paid".
        const exact = columns.find((c) => targets.includes(normaliseForMatch(c.header)));
        const loose =
            exact ??
            columns.find((c) => {
                const h = normaliseForMatch(c.header);
                return targets.some((t) => t !== "" && (h.includes(t) || t.includes(h)));
            });

        if (loose && loose.header.trim() !== "") mapping[f.name] = loose.header;
    }
    return mapping;
}

/**
 * Validate that every template variable — body positions **and** the
 * button/payment-link variable — is bound to a column, so a send never silently
 * renders blank variables. A field is unmapped when its mapping value is
 * absent/blank, or (when `columns` is supplied) names a header not in the upload.
 * The unmapped fields are returned in field order for a specific operator warning.
 */
export function validateVariableMapping(
    fields: readonly TemplateVariableField[],
    mapping: Readonly<Record<string, string>>,
    columns?: readonly DetectedColumn[],
): VariableMappingValidation {
    const unmapped = fields.filter((f) => {
        const header = (mapping[f.name] ?? "").trim();
        if (header === "") return true;
        if (columns && !columns.some((c) => c.header === header)) return true;
        return false;
    });
    return { complete: unmapped.length === 0, unmapped };
}

/**
 * Serialise the operator's mapping to the JSON string persisted on the campaign
 * (`whatsappVariableMappings`) and read unchanged by the send path. Only fields
 * with a non-blank header are emitted; keys are the logical variable names. An
 * all-blank mapping still serialises (to `{}`) so the field round-trips.
 */
export function serialiseVariableMapping(
    fields: readonly TemplateVariableField[],
    mapping: Readonly<Record<string, string>>,
): string {
    const out: Record<string, string> = {};
    for (const f of fields) {
        const header = (mapping[f.name] ?? "").trim();
        if (header !== "") out[f.name] = header;
    }
    return JSON.stringify(out);
}

/**
 * Resolve every template variable's value from a **real uploaded row** via the
 * authored mapping, for the WhatsApp final preview (issue #88). Given the template,
 * the persisted `whatsappVariableMappings` JSON, and one materialised recipient's
 * cell bag (`{ header: cell }`), it returns the `{ variableName: value }` map the
 * {@link WhatsAppPreview} renders — so the operator sees this recipient's own first
 * name, invoice number, amount and payment link before sending, not static
 * placeholders (parity with the email upload preview's real-row approach).
 *
 * Fidelity is the point: it resolves through {@link resolveRowVariables} — the exact
 * core the send path uses — so the preview mirrors what will actually be sent. A
 * variable with no authored column (and no column literally named after it) resolves
 * to an empty string, making the empty-variable problem visible pre-send. A
 * null/blank/garbage mapping is tolerated (every variable resolves blank), never
 * throwing.
 */
export function resolvePreviewVariableValues(
    template: WhatsAppTemplateShape,
    mappingJson: string | null | undefined,
    rowBag: Readonly<Record<string, string>>,
): Record<string, string> {
    const names = templateVariableFields(template).map((f) => f.name);
    const mappings = parseDefaultMappings(mappingJson);
    return resolveRowVariables(names, mappings, rowBag);
}
