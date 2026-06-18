/**
 * Canonical, stable serialisation of a value for use as a React effect key.
 *
 * Two structurally-equal values always serialise to the same string regardless
 * of object key order or reference identity. An effect keyed on the result
 * therefore fires when a filter *value* changes — not when an incidental
 * re-render re-creates the filter object with the same values. Object keys are
 * sorted; arrays keep their order (order is meaningful for the input filters).
 */
export function filterSignature(value: unknown): string {
    return JSON.stringify(canonicalise(value)) ?? "";
}

function canonicalise(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalise);
    }
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = canonicalise(obj[key]);
        }
        return sorted;
    }
    return value;
}
