"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, FileText, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { readContactIdsFromFile, extractContactIdsForColumnFromFile } from "./readContactIds";
import type { ContactIdExtraction, DetectedColumn } from "./extractContactIds";

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
 * When detection is `ambiguous` (#54) the panel keeps the dropped file and the
 * extraction's `candidates`, and shows a column-chooser dropdown. Picking a
 * column re-reads that file through {@link extractContactIdsForColumnFromFile}
 * — the same validate / dedupe / skip pipeline — and feeds the result back
 * through the very same `onResult` seam, so a hand-picked column activates the
 * `{ contactIds }` selection exactly like an auto-detected one.
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
    // The ambiguous file awaiting a manual column choice (#54), and the columns
    // to offer. Held here (not on the page) because re-extraction re-reads the
    // same file. Cleared the moment a different file is dropped or detection
    // resolves cleanly; kept after a pick so a wrong choice can be re-picked.
    const [chooser, setChooser] = useState<{ file: File; candidates: DetectedColumn[] } | null>(null);

    const handleFile = useCallback(
        async (file: File) => {
            setIsParsing(true);
            try {
                const extraction = await readContactIdsFromFile(file);
                setChooser(
                    extraction.status === "ambiguous"
                        ? { file, candidates: extraction.candidates }
                        : null,
                );
                onResult(extraction, file.name);
            } finally {
                setIsParsing(false);
            }
        },
        [onResult],
    );

    const handleChooseColumn = useCallback(
        async (columnIndex: number) => {
            if (!chooser) return;
            const { file } = chooser;
            setIsParsing(true);
            try {
                const extraction = await extractContactIdsForColumnFromFile(file, columnIndex);
                onResult(extraction, file.name);
            } finally {
                setIsParsing(false);
            }
        },
        [chooser, onResult],
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
                    The file needs a <span className="font-mono">contactid</span> column of Dynamics
                    contact ids. It is used only to target recipients.
                </p>
            </div>

            {!isParsing && result && result.status !== "ambiguous" && (
                <UploadStatus result={result} fileName={fileName} />
            )}
            {!isParsing && chooser && (
                <ColumnChooser candidates={chooser.candidates} onChoose={handleChooseColumn} />
            )}
        </div>
    );
}

/**
 * Manual column choice for an ambiguous file (#54). Lists the extraction's
 * `candidates` so the user names the contact-id column; the selection runs the
 * same pipeline as auto-detection. Shown only while `chooser` is set — i.e.
 * never for auto-detected (tier 1–3) files.
 */
function ColumnChooser({
    candidates,
    onChoose,
}: {
    candidates: DetectedColumn[];
    onChoose: (columnIndex: number) => void;
}) {
    return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="space-y-2 text-sm text-amber-800">
                <p className="font-medium">We couldn’t identify the contact-id column automatically.</p>
                <p>Choose which column holds the Dynamics contact ids:</p>
                <select
                    defaultValue=""
                    onChange={(e) => {
                        if (e.target.value !== "") onChoose(Number(e.target.value));
                    }}
                    className="w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm text-gray-800 focus:border-[#1E3A5F] focus:outline-none"
                >
                    <option value="" disabled>
                        Select a column…
                    </option>
                    {candidates.map((c) => (
                        <option key={c.index} value={c.index}>
                            {c.header || `Column ${c.index + 1}`}
                        </option>
                    ))}
                </select>
            </div>
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
    // `ambiguous` never reaches here — that status renders the ColumnChooser
    // instead of UploadStatus. The remaining no-ids cases are an empty file and
    // a resolved column (auto-detected or hand-picked) that held no valid ids.
    return result.status === "empty"
        ? "The file is empty."
        : "No valid contact ids were found in the id column.";
}
