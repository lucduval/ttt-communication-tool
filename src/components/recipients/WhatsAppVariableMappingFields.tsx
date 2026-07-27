"use client";

import { ColumnSelect } from "./ColumnSelect";
import { validateVariableMapping, type TemplateVariableField } from "./whatsappVariableMapping";
import type { DetectedColumn } from "./extractContactIds";

/**
 * The WhatsApp variable→column mapping controls (PRD #84, issue #86; extracted to a
 * reusable component in PRD #90, issue #92). Rendered wherever an operator authors
 * the mapping — the recipients-step upload panel today, the compose-step editor in
 * the follow-on slice — so the two surfaces can never drift.
 *
 * Purely presentational and fully controlled: it takes the template's variable
 * `fields`, the uploaded `columns`, the `mapping` object it should display, and a
 * `onChange(name, header)` handler it fires when a dropdown changes. It holds no
 * state of its own — the owner (the wizard page, via {@link mergeGuessedMapping})
 * is the single source of truth for the mapping value.
 *
 * Each template variable shows its human-readable label — `{{1}} — First name`,
 * "Payment link" — and a column dropdown. A warning names any variable still
 * unmapped so the operator never unknowingly sends a blank `{{n}}`.
 */
export function WhatsAppVariableMapping({
    fields,
    columns,
    mapping,
    onChange,
}: {
    /** WhatsApp template variables to map (body positions + button variables). */
    fields: TemplateVariableField[];
    /** The uploaded file's detected columns. */
    columns: DetectedColumn[];
    /** Current variable→header mapping (owned by the caller). */
    mapping: Record<string, string>;
    /** Fires when a variable's column selection changes. */
    onChange: (name: string, header: string) => void;
}) {
    const { unmapped } = validateVariableMapping(fields, mapping, columns);

    return (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-sm font-medium text-gray-700">
                Map each WhatsApp template variable to a column:
            </p>
            {fields.map((f) => (
                <ColumnSelect
                    key={f.name}
                    label={f.position ? `{{${f.position}}} — ${f.label}` : f.label}
                    required
                    value={mapping[f.name] ?? ""}
                    columns={columns}
                    onChange={(h) => onChange(f.name, h)}
                />
            ))}
            {unmapped.length > 0 && (
                <p className="text-xs text-amber-700">
                    Map{" "}
                    {unmapped
                        .map((f) => (f.position ? `{{${f.position}}} (${f.label})` : f.label))
                        .join(", ")}{" "}
                    to a column — unmapped variables send blank.
                </p>
            )}
        </div>
    );
}
