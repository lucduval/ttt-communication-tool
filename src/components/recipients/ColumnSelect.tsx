"use client";

import type { DetectedColumn } from "./extractContactIds";

/**
 * A single labelled "pick a column" dropdown over the uploaded file's headers —
 * the shared control behind both the role-designation dropdowns and the WhatsApp
 * variable→column mapping (PRD #90, issue #92). Extracted so the mapping component
 * and the upload panel render the exact same control; kept purely presentational
 * (value + change handler in, no state of its own).
 */
export function ColumnSelect({
    label,
    required,
    value,
    columns,
    onChange,
}: {
    label: string;
    required: boolean;
    value: string;
    columns: DetectedColumn[];
    onChange: (header: string) => void;
}) {
    return (
        <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-600">
                {label}
                {required && <span className="text-red-600"> *</span>}
            </span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 focus:border-[#1E3A5F] focus:outline-none"
            >
                <option value="">{required ? "Select a column…" : "None"}</option>
                {columns.map((c) => (
                    <option key={c.index} value={c.header}>
                        {c.header || `Column ${c.index + 1}`}
                    </option>
                ))}
            </select>
        </label>
    );
}
