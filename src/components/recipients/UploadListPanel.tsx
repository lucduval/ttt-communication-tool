"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, FileText, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { readUploadedColumnsFromFile } from "./readContactIds";
import {
    prepareUploadForSend,
    type UploadedColumns,
    type PersistedColumnRoles,
    type HeldRow,
} from "./columnRoles";
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
    /** Recipients materialised from the rows — the `upload`-shape selection value. */
    recipients: CampaignRecipient[];
    /** The designation persisted on the campaign (by header, survives a re-export). */
    roles: PersistedColumnRoles;
    /** Rows held out (blank/duplicate tracking key) for the pre-send report. */
    held: HeldRow[];
    fileName: string;
}

/** Local role selection — header strings; `""` means "not yet designated". */
type RoleSelection = { sendAddress: string; trackingKey: string; invoiceGuid: string };

const EMPTY_ROLES: RoleSelection = { sendAddress: "", trackingKey: "", invoiceGuid: "" };

/**
 * Best-effort initial guess for each role from the column headers, so a
 * conventional CRM export lands designated. The operator can always override.
 */
function guessRoles(columns: DetectedColumn[]): RoleSelection {
    const find = (re: RegExp) => columns.find((c) => re.test(c.header))?.header ?? "";
    return {
        // "email" but not "emailoptin" etc. — a plain address column.
        sendAddress: find(/^e-?mail$|email address/i),
        trackingKey: find(/contact\s*id|tracking\s*key|contactid/i),
        invoiceGuid: find(/invoice.*(guid|id)/i),
    };
}

export function UploadListPanel({
    requireSendAddress,
    onResult,
}: {
    /** Email/personalised campaigns must designate a send address; WhatsApp need not. */
    requireSendAddress: boolean;
    /** Fires with the materialised result, or `null` while the designation is incomplete. */
    onResult: (result: UploadRolesResult | null) => void;
}) {
    const [isDragging, setIsDragging] = useState(false);
    const [isParsing, setIsParsing] = useState(false);
    const [columns, setColumns] = useState<UploadedColumns | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [roles, setRoles] = useState<RoleSelection>(EMPTY_ROLES);
    const inputRef = useRef<HTMLInputElement>(null);

    // Re-run the pure materialisation whenever the designation changes and push
    // the result (or null) up. Kept in one place so every dropdown change and the
    // initial guess funnel through the same seam.
    const recompute = useCallback(
        (cols: UploadedColumns | null, sel: RoleSelection, name: string | null) => {
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
            };
            const prepared = prepareUploadForSend(cols, persisted);
            if (prepared.status !== "ok") {
                onResult(null); // a designated header vanished — hold the upload
                return;
            }
            onResult({ recipients: prepared.recipients, roles: persisted, held: prepared.held, fileName: name });
        },
        [onResult, requireSendAddress],
    );

    const handleFile = useCallback(
        async (file: File) => {
            setIsParsing(true);
            try {
                const cols = await readUploadedColumnsFromFile(file);
                const guessed = guessRoles(cols.columns);
                setColumns(cols);
                setFileName(file.name);
                setRoles(guessed);
                recompute(cols, guessed, file.name);
            } finally {
                setIsParsing(false);
            }
        },
        [recompute],
    );

    const setRole = useCallback(
        (role: keyof RoleSelection, header: string) => {
            setRoles((prev) => {
                const next = { ...prev, [role]: header };
                recompute(columns, next, fileName);
                return next;
            });
        },
        [columns, fileName, recompute],
    );

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
                    the tracking key, and the invoice below — the rest are available as{" "}
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
                    fileName={fileName}
                    onRole={setRole}
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
    fileName,
    onRole,
}: {
    columns: UploadedColumns;
    roles: RoleSelection;
    requireSendAddress: boolean;
    fileName: string | null;
    onRole: (role: keyof RoleSelection, header: string) => void;
}) {
    const requiredMissing =
        roles.trackingKey === "" || (requireSendAddress && roles.sendAddress === "");

    // Derive the report the same way the page derives the send payload.
    const prepared =
        !requiredMissing
            ? prepareUploadForSend(columns, {
                  trackingKey: roles.trackingKey,
                  sendAddress: roles.sendAddress || undefined,
                  invoiceGuid: roles.invoiceGuid || undefined,
              })
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

            {prepared?.status === "ok" && (
                <UploadReport recipients={prepared.recipients.length} held={prepared.held} />
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

/** The pre-send report: how many rows will send, and why any are held. */
function UploadReport({ recipients, held }: { recipients: number; held: HeldRow[] }) {
    const missing = held.filter((h) => h.reason === "missing-tracking-key").length;
    const duplicate = held.filter((h) => h.reason === "duplicate-tracking-key").length;

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
                    {recipients.toLocaleString()} recipient{recipients === 1 ? "" : "s"} ready to send.
                </p>
                {held.length > 0 && (
                    <p>
                        {held.length.toLocaleString()} row{held.length === 1 ? "" : "s"} held —{" "}
                        {duplicate > 0 && `${duplicate} with a duplicate tracking key (multi-invoice contact)`}
                        {duplicate > 0 && missing > 0 && ", "}
                        {missing > 0 && `${missing} with a missing/invalid tracking key`}. Fix the export
                        and re-upload to include them.
                    </p>
                )}
            </div>
        </div>
    );
}
