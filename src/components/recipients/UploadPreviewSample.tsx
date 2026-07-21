"use client";

import { useState } from "react";
import { FileText, Loader2, Paperclip, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { buildPreviewMessages, type PreviewMessage } from "./previewSample";
import type { EmailType } from "../../../convex/lib/composeEmailContent";
import type { MaterialisedRecipient } from "./columnRoles";

/**
 * Pre-send preview of a sample of rendered messages for an upload campaign (PRD
 * `prd-bad-debt-excel-campaign.md`, issue #71, user story #29).
 *
 * This is the operator's sanity check before committing to a send. It draws from the
 * validation report's `sendable` recipients — the exact rows the send path is allowed
 * to send (#67) — renders each through the real merge engine ({@link buildPreviewMessages},
 * which composes `applyMerge`, #66), and lets the operator open that recipient's own
 * invoice PDF, generated on demand from the same Azure boundary the real send uses
 * (`invoicePdfs.previewInvoicePdf`, #68/#69). No mock: merged values *and* attachment
 * are a true picture of what goes out.
 */

const SAMPLE_SIZE = 3;

type PdfState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; url: string }
    | { status: "error"; message: string };

export function UploadPreviewSample({
    subject,
    htmlContent,
    senderEmail,
    recipients,
    invoiceGuidDesignated,
    emailType,
    unsubscribeUrl,
    disclaimerHtml,
    generatePdf,
}: {
    subject: string;
    htmlContent: string;
    senderEmail?: string;
    /** The validation report's `sendable` recipients — the same rows that would be sent. */
    recipients: readonly MaterialisedRecipient[];
    /** Whether the campaign designated an invoice-GUID role (drives the PDF affordance). */
    invoiceGuidDesignated: boolean;
    /** The campaign's email type — decides whether the preview shows the unsubscribe footer. */
    emailType?: EmailType;
    /** A representative unsubscribe URL; empty/absent means none is configured (no footer). */
    unsubscribeUrl?: string;
    /** The selected disclaimer's HTML, appended (merged) above the unsubscribe footer; absent = "None". */
    disclaimerHtml?: string;
    /** Generate one recipient's invoice PDF on demand; resolves to a viewable URL or an error. */
    generatePdf: (
        invoiceGuid: string,
    ) => Promise<{ success: true; url: string } | { success: false; error: string }>;
}) {
    const messages = buildPreviewMessages(subject, htmlContent, recipients, SAMPLE_SIZE, {
        emailType,
        unsubscribeUrl,
        disclaimerHtml,
    });

    if (messages.length === 0) {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
                <AlertTriangle className="h-5 w-5 shrink-0 text-gray-400" />
                <p>
                    No rows are cleared to send yet, so there is nothing to preview. Designate the
                    column roles and clear the validation report first.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <p className="text-sm text-gray-600">
                Showing {messages.length} of {recipients.length.toLocaleString()} recipient
                {recipients.length === 1 ? "" : "s"} cleared to send — merged from the uploaded rows,
                exactly as each message will render.
            </p>
            {messages.map((msg) => (
                <PreviewCard
                    key={msg.recipientId}
                    message={msg}
                    senderEmail={senderEmail}
                    invoiceGuidDesignated={invoiceGuidDesignated}
                    generatePdf={generatePdf}
                />
            ))}
        </div>
    );
}

function PreviewCard({
    message,
    senderEmail,
    invoiceGuidDesignated,
    generatePdf,
}: {
    message: PreviewMessage;
    senderEmail?: string;
    invoiceGuidDesignated: boolean;
    generatePdf: (
        invoiceGuid: string,
    ) => Promise<{ success: true; url: string } | { success: false; error: string }>;
}) {
    const [pdf, setPdf] = useState<PdfState>({ status: "idle" });
    const [showValues, setShowValues] = useState(false);

    const loadPdf = async () => {
        if (!message.invoiceGuid) return;
        setPdf({ status: "loading" });
        try {
            const result = await generatePdf(message.invoiceGuid);
            if (result.success) setPdf({ status: "ready", url: result.url });
            else setPdf({ status: "error", message: result.error });
        } catch (err) {
            setPdf({
                status: "error",
                message: err instanceof Error ? err.message : "Failed to generate the invoice PDF.",
            });
        }
    };

    const valueEntries = Object.entries(message.mergedValues);

    return (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            {/* Header — from / to / subject */}
            <div className="bg-gray-50 border-b border-gray-200 p-4 space-y-1.5 text-sm">
                <div className="flex">
                    <span className="text-gray-500 w-20">From:</span>
                    <span className="text-gray-900 font-medium">
                        {senderEmail || "communications@yourcompany.com"}
                    </span>
                </div>
                <div className="flex">
                    <span className="text-gray-500 w-20">To:</span>
                    <span className="text-gray-900">{message.sendAddress || "(no send address)"}</span>
                </div>
                <div className="flex">
                    <span className="text-gray-500 w-20">Subject:</span>
                    <span className="text-gray-900 font-semibold">{message.subject || "(No subject)"}</span>
                </div>
                {invoiceGuidDesignated && (
                    <div className="flex items-center">
                        <span className="text-gray-500 w-20">Attachment:</span>
                        <PdfAffordance state={pdf} onLoad={loadPdf} hasGuid={!!message.invoiceGuid} />
                    </div>
                )}
            </div>

            {/* Merged body */}
            <div
                className="min-h-[160px] bg-white"
                style={{
                    padding: "16px 20px",
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: "15px",
                    lineHeight: "1.45",
                    color: "#333333",
                }}
                dangerouslySetInnerHTML={{
                    __html:
                        message.body ||
                        "<p style='color:#9ca3af;font-style:italic;'>(empty body)</p>",
                }}
            />

            {/* The generated PDF, inline once loaded */}
            {pdf.status === "ready" && (
                <div className="border-t border-gray-200 bg-gray-50 p-3">
                    <iframe
                        title={`Invoice PDF for ${message.sendAddress ?? message.recipientId}`}
                        src={pdf.url}
                        className="w-full h-[420px] rounded border border-gray-200 bg-white"
                    />
                </div>
            )}

            {/* Merged-values table — the raw cells the merge drew on */}
            {valueEntries.length > 0 && (
                <div className="border-t border-gray-200">
                    <button
                        type="button"
                        onClick={() => setShowValues((s) => !s)}
                        className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                    >
                        <span>Merged values ({valueEntries.length} columns)</span>
                        {showValues ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    {showValues && (
                        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 px-4 pb-3 text-xs">
                            {valueEntries.map(([header, value]) => (
                                <div key={header} className="contents">
                                    <dt className="truncate font-mono text-gray-500">{header}</dt>
                                    <dd className="truncate text-gray-800">{value || "—"}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                </div>
            )}
        </div>
    );
}

function PdfAffordance({
    state,
    onLoad,
    hasGuid,
}: {
    state: PdfState;
    onLoad: () => void;
    hasGuid: boolean;
}) {
    if (!hasGuid) {
        return <span className="text-xs text-amber-700">no invoice GUID on this row</span>;
    }
    if (state.status === "loading") {
        return (
            <span className="flex items-center gap-1 text-xs text-gray-500">
                <Loader2 size={12} className="animate-spin" />
                Generating invoice PDF…
            </span>
        );
    }
    if (state.status === "error") {
        return (
            <button
                type="button"
                onClick={onLoad}
                className="flex items-center gap-1 text-xs text-red-600 hover:underline"
            >
                <AlertTriangle size={12} />
                {state.message} — retry
            </button>
        );
    }
    if (state.status === "ready") {
        return (
            <span className="flex items-center gap-1 text-xs text-green-700">
                <FileText size={12} />
                invoice.pdf (shown below)
            </span>
        );
    }
    return (
        <button
            type="button"
            onClick={onLoad}
            className="flex items-center gap-1 text-xs font-medium text-[#1E3A5F] hover:underline"
        >
            <Paperclip size={12} />
            Generate &amp; preview invoice PDF
        </button>
    );
}
