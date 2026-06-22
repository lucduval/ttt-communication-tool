"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, FileText, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { readContactIdsFromFile } from "./readContactIds";
import type { ContactIdExtraction } from "./extractContactIds";

/**
 * "Upload list" audience panel (PRD #48, issue #50).
 *
 * A dropzone that swaps in for the filter panel when the Upload-list audience
 * mode is active. It reads a dropped CSV through the impure
 * {@link readContactIdsFromFile} seam and hands the pure extraction result back
 * up via `onResult`; the page turns a successful result into the same
 * `filtered` selection carrying `{ contactIds }` that the send path (#49)
 * already understands. The file is purely a source of contact ids — never
 * per-recipient template data.
 *
 * This panel only renders and parses; the count badge and the recipient total
 * live with the selection value on the page, so the displayed status is read
 * from the `result`/`fileName` props rather than owned here.
 */
export function UploadListPanel({
    result,
    fileName,
    onResult,
}: {
    result: ContactIdExtraction | null;
    fileName: string | null;
    onResult: (result: ContactIdExtraction, fileName: string) => void;
}) {
    const [isDragging, setIsDragging] = useState(false);
    const [isParsing, setIsParsing] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFile = useCallback(
        async (file: File) => {
            setIsParsing(true);
            try {
                const extraction = await readContactIdsFromFile(file);
                onResult(extraction, file.name);
            } finally {
                setIsParsing(false);
            }
        },
        [onResult],
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
                    accept=".csv,text/csv"
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
                    {isParsing ? "Reading file…" : "Drop a CSV here, or click to choose a file"}
                </p>
                <p className="text-xs text-gray-500">
                    The file needs a <span className="font-mono">contactid</span> column of Dynamics
                    contact ids. It is used only to target recipients.
                </p>
            </div>

            {result && !isParsing && <UploadStatus result={result} fileName={fileName} />}
        </div>
    );
}

function UploadStatus({
    result,
    fileName,
}: {
    result: ContactIdExtraction;
    fileName: string | null;
}) {
    const validCount = result.contactIds.length;
    const hasIds = validCount > 0;

    if (!hasIds) {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                <div className="text-sm text-red-700">
                    <p className="font-medium">No contact ids found{fileName ? ` in ${fileName}` : ""}.</p>
                    <p>{errorMessage(result)}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3">
            <CheckCircle className="h-5 w-5 shrink-0 text-green-600" />
            <div className="text-sm text-green-800">
                <p className="flex items-center gap-1 font-medium">
                    <FileText className="h-4 w-4" />
                    {validCount.toLocaleString()} contact id{validCount === 1 ? "" : "s"} found
                    {fileName ? ` in ${fileName}` : ""}
                    {result.skippedRows > 0
                        ? ` — ${result.skippedRows.toLocaleString()} row${
                              result.skippedRows === 1 ? "" : "s"
                          } skipped`
                        : ""}
                    .
                </p>
                <p className="text-green-700">
                    The final recipient count is confirmed at send: contacts you can&apos;t access,
                    that are unreachable on this channel, or no longer in the CRM are skipped.
                </p>
            </div>
        </div>
    );
}

function errorMessage(result: ContactIdExtraction): string {
    switch (result.status) {
        case "empty":
            return "The file is empty.";
        case "no-column":
            return "No column headed “contactid” was found in the file.";
        case "ambiguous":
            return "More than one “contactid” column was found — please use a file with a single id column.";
        default:
            return "No valid contact ids were found in the contactid column.";
    }
}
