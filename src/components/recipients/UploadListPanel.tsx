"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileText, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { readUploadedColumnsFromFile } from "./readContactIds";
import {
    prepareUploadForSend,
    type UploadedColumns,
    type PersistedColumnRoles,
} from "./columnRoles";
import { extractPlaceholders, type ValidationReport, type ValidationHoldReason } from "./validationReport";
import {
    templateVariableFields,
    guessVariableMapping,
    validateVariableMapping,
    serialiseVariableMapping,
    type WhatsAppTemplateShape,
    type TemplateVariableField,
} from "./whatsappVariableMapping";
import type { DetectedColumn } from "./extractContactIds";
import type { CampaignRecipient } from "@/../convex/lib/recipientSelection";

/**
 * "Upload list" audience panel — role-designation flow (PRD
 * `prd-bad-debt-excel-campaign.md`, issue #65).
 *
 * This is the load-bearing reversal of the uploaded-file model. Where the
 * original panel treated a file as *only* a bag of contact ids (extract one
 * column, discard the rest, re-resolve everything from Dynamics at send), this
 * panel **retains every column** and lets the operator designate roles:
 *
 *   - **send address** (email column) — required for email/personalised sends,
 *   - **tracking key** (contact GUID) — always required; the recipient identity,
 *   - **invoice GUID** — optional; drives the per-recipient PDF slice (#68).
 *
 * Every remaining column stays available as a `{column}` merge variable. Once
 * the required roles are designated the panel materialises the rows via the pure
 * {@link prepareUploadForSend} seam — keying each recipient by its tracking-key
 * value and carrying the full row as a JSON `variables` bag — and hands the
 * result up via `onResult`. The page turns that into an `upload`-shape selection
 * whose recipients flow straight to the send path with **no CRM round-trip**.
 *
 * Rows that cannot be identified (blank/duplicate tracking key) are *held*, never
 * silently dropped, and surfaced here as the pre-send report's first slice (#67).
 *
 * The panel only renders, parses, and designates; the count badge and recipient
 * total live with the selection value on the page.
 */

/** What the panel hands up once a valid designation materialises recipients. */
export interface UploadRolesResult {
    /**
     * Recipients cleared to send — the `upload`-shape selection value. Held rows
     * (tracking-key *and* content holds from the validation gate) are excluded, so
     * the send path only ever sees sendable recipients (#67).
     */
    recipients: CampaignRecipient[];
    /** The designation persisted on the campaign (by header, survives a re-export). */
    roles: PersistedColumnRoles;
    /** The consolidated pre-send validation report — held rows and why (#67). */
    report: ValidationReport;
    /**
     * The WhatsApp variable→column mapping as the JSON string persisted on the
     * campaign (`whatsappVariableMappings`) and read unchanged by the send path.
     * Present only for a WhatsApp upload (a template was supplied); `undefined`
     * for email/personalised uploads, which have no positional variables (#86).
     */
    whatsappVariableMappings?: string;
    fileName: string;
}

/** Local role selection — header strings; `""` means "not yet designated". */
export type RoleSelection = {
    sendAddress: string;
    trackingKey: string;
    invoiceGuid: string;
    ccAddress: string;
    phone: string;
};

const EMPTY_ROLES: RoleSelection = {
    sendAddress: "",
    trackingKey: "",
    invoiceGuid: "",
    ccAddress: "",
    phone: "",
};

/**
 * Best-effort initial guess for each role from the column headers, so a
 * conventional CRM export lands designated. The operator can always override.
 */
export function guessRoles(columns: DetectedColumn[]): RoleSelection {
    const find = (re: RegExp) => columns.find((c) => re.test(c.header))?.header ?? "";
    return {
        // "email" but not "emailoptin" etc. — a plain address column.
        sendAddress: find(/^e-?mail$|email address/i),
        trackingKey: find(/contact\s*id|tracking\s*key|contactid/i),
        invoiceGuid: find(/invoice.*(guid|id)/i),
        // Prefer a consultant *email* header; fall back to a bare consultant/adviser
        // column so a likely per-recipient CC is pre-filled for the operator (#83).
        ccAddress:
            find(/consultant.*e-?mail|e-?mail.*consultant/i) ||
            find(/consultant|advis[eo]r/i),
        // Common mobile-number headers — phone, mobile, cell, msisdn, whatsapp
        // (#85). An absent phone column leaves this blank.
        phone: find(/phone|mobile|cell|msisdn|whats\s*app/i),
    };
}

export function UploadListPanel({
    requireSendAddress,
    templateText,
    whatsappTemplate,
    onResult,
}: {
    /** Email/personalised campaigns must designate a send address; WhatsApp need not. */
    requireSendAddress: boolean;
    /**
     * The template text (subject + body) whose `{placeholder}`s the validation gate
     * checks against the uploaded columns. Passed as raw text so the panel derives
     * — and memoises — the placeholder list itself (stable identity, no render loop).
     */
    templateText?: string;
    /**
     * The selected WhatsApp template, for a WhatsApp upload only. Its positional
     * body variables + button variable become the variable→column mapping the
     * operator authors here (pre-filled from the headers, always editable); the
     * result carries the mapping as the campaign's `whatsappVariableMappings` JSON.
     * `undefined` for email/personalised uploads, which show no mapping (#86).
     */
    whatsappTemplate?: WhatsAppTemplateShape | null;
    /** Fires with the materialised result, or `null` while the designation is incomplete. */
    onResult: (result: UploadRolesResult | null) => void;
}) {
    const [isDragging, setIsDragging] = useState(false);
    const [isParsing, setIsParsing] = useState(false);
    const [columns, setColumns] = useState<UploadedColumns | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [roles, setRoles] = useState<RoleSelection>(EMPTY_ROLES);
    // The WhatsApp variable→column mapping: logical variable name → column header.
    // Pre-filled from a guess when a file lands (and re-guessed if the template
    // changes), then freely edited via the mapping dropdowns.
    const [varMapping, setVarMapping] = useState<Record<string, string>>({});
    const inputRef = useRef<HTMLInputElement>(null);

    // Derive the referenced placeholders once per template change (stable identity
    // so the effect below does not re-fire every parent render).
    const placeholders = useMemo(() => extractPlaceholders(templateText ?? ""), [templateText]);

    // The template's variables the operator must map (empty for a non-WhatsApp
    // upload). Memoised so downstream memo/effects have a stable identity.
    const varFields = useMemo<TemplateVariableField[]>(
        () => (whatsappTemplate ? templateVariableFields(whatsappTemplate) : []),
        [whatsappTemplate],
    );

    // The mapping serialised to the campaign JSON, or undefined when there are no
    // variables to map (email/personalised uploads carry no `whatsappVariableMappings`).
    const whatsappVariableMappings = useMemo(
        () => (varFields.length > 0 ? serialiseVariableMapping(varFields, varMapping) : undefined),
        [varFields, varMapping],
    );

    // Re-run the pure gate whenever the designation changes and push the result (or
    // null) up. Kept in one place so every dropdown change and the initial guess
    // funnel through the same seam.
    const recompute = useCallback(
        (
            cols: UploadedColumns | null,
            sel: RoleSelection,
            name: string | null,
            mappingsJson: string | undefined,
            whatsapp: { fields: TemplateVariableField[]; mapping: Record<string, string> } | undefined,
        ) => {
            if (!cols || cols.status === "empty" || !name) {
                onResult(null);
                return;
            }
            if (sel.trackingKey === "" || (requireSendAddress && sel.sendAddress === "")) {
                onResult(null); // required roles not yet designated
                return;
            }
            const persisted: PersistedColumnRoles = {
                trackingKey: sel.trackingKey,
                sendAddress: sel.sendAddress || undefined,
                invoiceGuid: sel.invoiceGuid || undefined,
                ccAddress: sel.ccAddress || undefined,
                phone: sel.phone || undefined,
            };
            const prepared = prepareUploadForSend(cols, persisted, { placeholders, whatsapp });
            if (prepared.status !== "ok" || !prepared.report) {
                onResult(null); // a designated header vanished — hold the upload
                return;
            }
            onResult({
                recipients: prepared.recipients,
                roles: persisted,
                report: prepared.report,
                whatsappVariableMappings: mappingsJson,
                fileName: name,
            });
        },
        [onResult, requireSendAddress, placeholders],
    );

    // Re-run the gate when the template's placeholders — or the variable mapping —
    // change after an upload, so a newly-added `{column}` (or a mapping edit)
    // re-pushes the result without a re-upload. `whatsappVariableMappings` is passed
    // as an argument (not closed over) so `recompute` keeps a stable identity.
    useEffect(() => {
        const whatsapp =
            varFields.length > 0 ? { fields: varFields, mapping: varMapping } : undefined;
        recompute(columns, roles, fileName, whatsappVariableMappings, whatsapp);
    }, [
        placeholders,
        columns,
        roles,
        fileName,
        whatsappVariableMappings,
        varFields,
        varMapping,
        recompute,
    ]);

    const handleFile = useCallback(
        async (file: File) => {
            setIsParsing(true);
            try {
                const cols = await readUploadedColumnsFromFile(file);
                const guessed = guessRoles(cols.columns);
                setColumns(cols);
                setFileName(file.name);
                setRoles(guessed);
                // Pre-fill the WhatsApp variable→column mapping from the headers too
                // (empty for a non-WhatsApp upload). Always editable below.
                setVarMapping(guessVariableMapping(varFields, cols.columns));
                // The effect re-runs the gate once these state updates commit —
                // no imperative recompute needed (and it double-fires `onResult`).
            } finally {
                setIsParsing(false);
            }
        },
        [varFields],
    );

    // Re-guess the mapping if the template's variables arrive/change after a file is
    // already loaded (e.g. the operator picks the template after uploading), so the
    // mapping section lands pre-filled rather than blank. Existing operator edits for
    // still-present variables are preserved; only newly-seen variables are guessed.
    const guessedFor = useRef<TemplateVariableField[] | null>(null);
    useEffect(() => {
        if (guessedFor.current === varFields) return;
        guessedFor.current = varFields;
        if (varFields.length === 0 || !columns || columns.status === "empty") return;
        const guess = guessVariableMapping(varFields, columns.columns);
        setVarMapping((prev) => {
            const next: Record<string, string> = {};
            for (const f of varFields) next[f.name] = prev[f.name] || guess[f.name] || "";
            return next;
        });
    }, [varFields, columns]);

    const setVar = useCallback((name: string, header: string) => {
        setVarMapping((prev) => ({ ...prev, [name]: header }));
    }, []);

    const setRole = useCallback((role: keyof RoleSelection, header: string) => {
        // Just update the designation; the effect above re-runs the gate. Calling
        // `recompute` (which fires `onResult` → parent setState) inside a setState
        // updater runs it during render — "Cannot update a component while rendering
        // a different component". The effect is the single, render-safe seam.
        setRoles((prev) => ({ ...prev, [role]: header }));
    }, []);

    const onDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
        },
        [handleFile],
    );

    return (
        <div className="space-y-4">
            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                onClick={() => inputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
                }}
                className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
                    isDragging
                        ? "border-[#1E3A5F] bg-blue-50"
                        : "border-gray-300 hover:border-[#1E3A5F] hover:bg-gray-50"
                }`}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                        e.target.value = ""; // allow re-selecting the same file
                    }}
                />
                {isParsing ? (
                    <Loader2 className="h-8 w-8 animate-spin text-[#1E3A5F]" />
                ) : (
                    <Upload className="h-8 w-8 text-gray-400" />
                )}
                <p className="text-sm font-medium text-gray-700">
                    {isParsing ? "Reading file…" : "Drop a CSV or Excel file here, or click to choose a file"}
                </p>
                <p className="text-xs text-gray-500">
                    The tool reads back every column. Designate which columns are the send address,
                    the tracking key, the invoice, and the consultant CC below — the rest are available as{" "}
                    <span className="font-mono">{"{column}"}</span> merge variables.
                </p>
            </div>

            {!isParsing && columns && columns.status === "empty" && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                    <div className="text-sm text-red-700">
                        <p className="font-medium">No columns found{fileName ? ` in ${fileName}` : ""}.</p>
                        <p>The file appears to be empty.</p>
                    </div>
                </div>
            )}

            {!isParsing && columns && columns.status === "ok" && (
                <RoleDesignation
                    columns={columns}
                    roles={roles}
                    requireSendAddress={requireSendAddress}
                    placeholders={placeholders}
                    fileName={fileName}
                    onRole={setRole}
                    varFields={varFields}
                    varMapping={varMapping}
                    onVar={setVar}
                />
            )}
        </div>
    );
}

/**
 * The three role dropdowns plus a live status line. Recomputing the recipients
 * on every change is the page's job (via `onRole` → `recompute`); this component
 * derives the *display* status from the same pure seam so the operator sees the
 * held-row report before sending (#67).
 */
function RoleDesignation({
    columns,
    roles,
    requireSendAddress,
    placeholders,
    fileName,
    onRole,
    varFields,
    varMapping,
    onVar,
}: {
    columns: UploadedColumns;
    roles: RoleSelection;
    requireSendAddress: boolean;
    placeholders: readonly string[];
    fileName: string | null;
    onRole: (role: keyof RoleSelection, header: string) => void;
    /** WhatsApp template variables to map (empty for a non-WhatsApp upload). */
    varFields: TemplateVariableField[];
    /** Current variable→header mapping. */
    varMapping: Record<string, string>;
    onVar: (name: string, header: string) => void;
}) {
    const requiredMissing =
        roles.trackingKey === "" || (requireSendAddress && roles.sendAddress === "");

    // Derive the report the same way the page derives the send payload — the full
    // gate, so the operator sees every held row and reason before sending (#67).
    const prepared =
        !requiredMissing
            ? prepareUploadForSend(
                  columns,
                  {
                      trackingKey: roles.trackingKey,
                      sendAddress: roles.sendAddress || undefined,
                      invoiceGuid: roles.invoiceGuid || undefined,
                      ccAddress: roles.ccAddress || undefined,
                      phone: roles.phone || undefined,
                  },
                  {
                      placeholders,
                      whatsapp:
                          varFields.length > 0
                              ? { fields: varFields, mapping: varMapping }
                              : undefined,
                  },
              )
            : null;

    return (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm font-medium text-gray-700">
                <FileText className="mr-1 inline h-4 w-4" />
                {columns.dataRows.length.toLocaleString()} row
                {columns.dataRows.length === 1 ? "" : "s"}
                {fileName ? ` in ${fileName}` : ""} — designate the columns:
            </p>

            <RoleSelect
                label="Send address (email)"
                required={requireSendAddress}
                value={roles.sendAddress}
                columns={columns.columns}
                onChange={(h) => onRole("sendAddress", h)}
            />
            <RoleSelect
                label="Tracking key (contact GUID)"
                required
                value={roles.trackingKey}
                columns={columns.columns}
                onChange={(h) => onRole("trackingKey", h)}
            />
            <RoleSelect
                label="Invoice GUID (optional)"
                required={false}
                value={roles.invoiceGuid}
                columns={columns.columns}
                onChange={(h) => onRole("invoiceGuid", h)}
            />
            <RoleSelect
                label="Consultant CC (optional)"
                required={false}
                value={roles.ccAddress}
                columns={columns.columns}
                onChange={(h) => onRole("ccAddress", h)}
            />
            <RoleSelect
                label="Phone (WhatsApp destination)"
                required={false}
                value={roles.phone}
                columns={columns.columns}
                onChange={(h) => onRole("phone", h)}
            />

            {varFields.length > 0 && (
                <VariableMapping
                    fields={varFields}
                    mapping={varMapping}
                    columns={columns.columns}
                    onVar={onVar}
                />
            )}

            {requiredMissing && (
                <p className="text-xs text-amber-700">
                    Designate the {requireSendAddress ? "send address and " : ""}tracking key to
                    continue.
                </p>
            )}

            {prepared?.status === "unresolved" && (
                <p className="text-xs text-red-700">
                    A designated column is no longer present in the file. Re-pick the roles.
                </p>
            )}

            {prepared?.status === "ok" && prepared.report && (
                <UploadReport report={prepared.report} />
            )}
        </div>
    );
}

function RoleSelect({
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

/**
 * The WhatsApp variable→column mapping section (#86). Rendered only for a WhatsApp
 * upload (the panel passes a non-empty `fields`). Each template variable shows its
 * human-readable label — `{{1}}` — First name, "Payment link" — and a column
 * dropdown, pre-filled from the guess and always editable. A warning names any
 * variable still unmapped so the operator never unknowingly sends blank `{{n}}`.
 */
function VariableMapping({
    fields,
    mapping,
    columns,
    onVar,
}: {
    fields: TemplateVariableField[];
    mapping: Record<string, string>;
    columns: DetectedColumn[];
    onVar: (name: string, header: string) => void;
}) {
    const { unmapped } = validateVariableMapping(fields, mapping, columns);

    return (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-sm font-medium text-gray-700">
                Map each WhatsApp template variable to a column:
            </p>
            {fields.map((f) => (
                <RoleSelect
                    key={f.name}
                    label={f.position ? `{{${f.position}}} — ${f.label}` : f.label}
                    required
                    value={mapping[f.name] ?? ""}
                    columns={columns}
                    onChange={(h) => onVar(f.name, h)}
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

/** A human phrase for each hold reason, for the consolidated report. */
const REASON_LABEL: Record<ValidationHoldReason, string> = {
    "missing-tracking-key": "a missing/invalid tracking key",
    "duplicate-tracking-key": "a duplicate tracking key (multi-invoice contact)",
    "unmatched-placeholder": "a template placeholder with no matching column",
    "empty-referenced-cell": "an empty cell in a referenced column",
    "invalid-send-address": "an invalid/missing send address",
    "missing-pdf": "no generated invoice PDF",
    "unmapped-variable": "an unmapped WhatsApp template variable",
    "missing-phone": "a blank/malformed phone number",
};

/**
 * The consolidated pre-send validation report (#67): how many rows will send, and
 * a count-per-reason of why any are held. One row can be held for several reasons,
 * so we tally each reason it carries.
 */
function UploadReport({ report }: { report: ValidationReport }) {
    const sendable = report.sendable.length;
    const held = report.held;

    // Count rows carrying each reason (a row may contribute to more than one).
    const counts = new Map<ValidationHoldReason, number>();
    for (const row of held) {
        for (const reason of row.reasons) {
            counts.set(reason, (counts.get(reason) ?? 0) + 1);
        }
    }
    const summary = [...counts.entries()].map(
        ([reason, n]) => `${n} with ${REASON_LABEL[reason]}`,
    );

    return (
        <div
            className={`flex items-start gap-2 rounded-lg border p-3 ${
                held.length > 0
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-green-200 bg-green-50 text-green-800"
            }`}
        >
            {held.length > 0 ? (
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            ) : (
                <CheckCircle className="h-5 w-5 shrink-0 text-green-600" />
            )}
            <div className="space-y-1 text-sm">
                <p className="font-medium">
                    {sendable.toLocaleString()} recipient{sendable === 1 ? "" : "s"} ready to send.
                </p>
                {report.unmatchedPlaceholders.length > 0 && (
                    <p>
                        Template placeholder{report.unmatchedPlaceholders.length === 1 ? "" : "s"}{" "}
                        with no matching column:{" "}
                        <span className="font-mono">
                            {report.unmatchedPlaceholders.map((p) => `{${p}}`).join(", ")}
                        </span>
                        . Add the column{report.unmatchedPlaceholders.length === 1 ? "" : "s"} or
                        remove the placeholder{report.unmatchedPlaceholders.length === 1 ? "" : "s"}.
                    </p>
                )}
                {report.unmappedVariables.length > 0 && (
                    <p>
                        WhatsApp template variable
                        {report.unmappedVariables.length === 1 ? "" : "s"} with no mapped column:{" "}
                        {report.unmappedVariables
                            .map((f) => (f.position ? `{{${f.position}}} (${f.label})` : f.label))
                            .join(", ")}
                        . Map {report.unmappedVariables.length === 1 ? "it" : "them"} to a column —
                        unmapped variables send blank.
                    </p>
                )}
                {report.phoneColumnMissing && (
                    <p>
                        No phone column is designated — a WhatsApp campaign has no destination for
                        any recipient. Designate the phone column above.
                    </p>
                )}
                {held.length > 0 && (
                    <p>
                        {held.length.toLocaleString()} row{held.length === 1 ? "" : "s"} held —{" "}
                        {summary.join(", ")}. Fix the export and re-upload to include them.
                    </p>
                )}
            </div>
        </div>
    );
}
