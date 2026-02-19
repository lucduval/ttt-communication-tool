"use client";

import { useState, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Loader2, RefreshCw, CheckCircle, AlertTriangle, Eye } from "lucide-react";
import type { Contact } from "@/components/recipients";

interface PreviewResult {
    contactId: string;
    contactName: string;
    html: string;
    income: number | null;
    raContribution: number | null;
    taxSaving: number | null;
    error?: string;
}

interface PersonalisedPreviewProps {
    selectedContacts: Contact[];
    aiSystemPrompt: string;
    aiUserPrompt: string;
    subject: string;
    onPreviewsGenerated: (generated: boolean) => void;
}

function fmt(n: number | null): string {
    if (n === null || n === undefined) return "—";
    return `R${Math.abs(Math.round(n)).toLocaleString("en-ZA")}`;
}

export function PersonalisedPreview({
    selectedContacts,
    aiSystemPrompt,
    aiUserPrompt,
    subject,
    onPreviewsGenerated,
}: PersonalisedPreviewProps) {
    const generatePreview = useAction(api.actions.personalised.generatePreviewEmail);

    const [previews, setPreviews] = useState<Map<string, PreviewResult>>(new Map());
    const [loading, setLoading] = useState<Set<string>>(new Set());
    const [isGeneratingAll, setIsGeneratingAll] = useState(false);
    const [expandedPreview, setExpandedPreview] = useState<string | null>(null);

    const sampleContacts = selectedContacts.slice(0, 8);

    const generateOne = useCallback(
        async (contact: Contact) => {
            setLoading((prev) => new Set(prev).add(contact.id));
            try {
                const result = await generatePreview({
                    contactId: contact.id,
                    aiPrompt: aiUserPrompt,
                    aiSystemPrompt: aiSystemPrompt || "",
                    subject,
                });
                setPreviews((prev) => {
                    const next = new Map(prev);
                    next.set(contact.id, {
                        contactId: contact.id,
                        contactName: contact.fullName,
                        html: result.html,
                        income: result.income ?? null,
                        raContribution: result.raContribution ?? null,
                        taxSaving: result.taxSaving ?? null,
                    });
                    return next;
                });
            } catch (err) {
                setPreviews((prev) => {
                    const next = new Map(prev);
                    next.set(contact.id, {
                        contactId: contact.id,
                        contactName: contact.fullName,
                        html: "",
                        income: null,
                        raContribution: null,
                        taxSaving: null,
                        error: err instanceof Error ? err.message : "Failed to generate preview",
                    });
                    return next;
                });
            } finally {
                setLoading((prev) => {
                    const next = new Set(prev);
                    next.delete(contact.id);
                    return next;
                });
            }
        },
        [generatePreview, aiUserPrompt, aiSystemPrompt, subject]
    );

    const generateAll = useCallback(async () => {
        setIsGeneratingAll(true);
        setPreviews(new Map());

        // Sequential with delay to avoid Gemini rate limits
        for (let i = 0; i < sampleContacts.length; i++) {
            await generateOne(sampleContacts[i]);
            if (i < sampleContacts.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 800));
            }
        }

        setIsGeneratingAll(false);
        onPreviewsGenerated(true);
    }, [sampleContacts, generateOne, onPreviewsGenerated]);

    const generatedCount = Array.from(previews.values()).filter((p) => !p.error).length;
    const errorCount = Array.from(previews.values()).filter((p) => p.error).length;

    return (
        <div className="space-y-6">
            {/* Header + Generate Button */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-gray-900">Preview AI-Generated Emails</h3>
                    <p className="text-sm text-gray-500 mt-1">
                        Generate and review sample emails for {sampleContacts.length} recipients before
                        sending.
                    </p>
                </div>
                <button
                    onClick={generateAll}
                    disabled={isGeneratingAll || !aiUserPrompt.trim()}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#1E3A5F] text-white rounded-lg font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#2C5282] transition-colors"
                >
                    {isGeneratingAll ? (
                        <>
                            <Loader2 size={16} className="animate-spin" />
                            Generating...
                        </>
                    ) : previews.size > 0 ? (
                        <>
                            <RefreshCw size={16} />
                            Regenerate All
                        </>
                    ) : (
                        <>
                            <Eye size={16} />
                            Generate Previews
                        </>
                    )}
                </button>
            </div>

            {/* Progress bar */}
            {previews.size > 0 && (
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                    {generatedCount === sampleContacts.length ? (
                        <CheckCircle size={18} className="text-green-600" />
                    ) : errorCount > 0 ? (
                        <AlertTriangle size={18} className="text-amber-600" />
                    ) : (
                        <Loader2 size={18} className="text-blue-600 animate-spin" />
                    )}
                    <span className="text-sm font-medium text-gray-700">
                        {generatedCount} of {sampleContacts.length} previews generated
                        {errorCount > 0 && ` (${errorCount} failed)`}
                    </span>
                </div>
            )}

            {/* Preview Cards */}
            <div className="grid grid-cols-1 gap-4">
                {sampleContacts.map((contact) => {
                    const preview = previews.get(contact.id);
                    const isLoading = loading.has(contact.id);
                    const isExpanded = expandedPreview === contact.id;

                    return (
                        <div
                            key={contact.id}
                            className="border border-gray-200 rounded-xl overflow-hidden bg-white"
                        >
                            {/* Card Header */}
                            <div className="flex items-center justify-between p-4 bg-gray-50 border-b border-gray-200">
                                <div className="flex items-center gap-3">
                                    <div className="w-9 h-9 bg-[#1E3A5F] text-white rounded-full flex items-center justify-center text-sm font-bold">
                                        {contact.fullName?.charAt(0) || "?"}
                                    </div>
                                    <div>
                                        <div className="font-semibold text-gray-900 text-sm">
                                            {contact.fullName}
                                        </div>
                                        <div className="text-xs text-gray-500">{contact.email}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    {preview && !preview.error && (
                                        <div className="flex gap-3 text-xs text-gray-500">
                                            <span>
                                                Income: <strong className="text-gray-700">{fmt(preview.income)}</strong>
                                            </span>
                                            <span>
                                                RA: <strong className="text-gray-700">{fmt(preview.raContribution)}</strong>
                                            </span>
                                            <span>
                                                Max Saving: <strong className="text-green-700">{fmt(preview.taxSaving)}</strong>
                                            </span>
                                        </div>
                                    )}
                                    {preview && !preview.error && (
                                        <button
                                            onClick={() => generateOne(contact)}
                                            disabled={isLoading}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                                        >
                                            <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
                                            Regenerate
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Card Body */}
                            {isLoading && !preview && (
                                <div className="flex items-center justify-center py-16">
                                    <div className="flex flex-col items-center gap-3">
                                        <Loader2 size={28} className="animate-spin text-[#1E3A5F]" />
                                        <span className="text-sm text-gray-500">
                                            Fetching tax data and generating email...
                                        </span>
                                    </div>
                                </div>
                            )}

                            {preview?.error && (
                                <div className="p-4">
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                                        <div className="flex items-center gap-2 text-sm text-red-700 font-medium">
                                            <AlertTriangle size={14} />
                                            {preview.error}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {preview && !preview.error && (
                                <div>
                                    <button
                                        onClick={() =>
                                            setExpandedPreview(isExpanded ? null : contact.id)
                                        }
                                        className="w-full px-4 py-2 text-xs font-medium text-[#1E3A5F] hover:bg-gray-50 transition-colors text-left"
                                    >
                                        {isExpanded ? "Collapse preview" : "Expand full email preview"}
                                    </button>
                                    {isExpanded && (
                                        <div className="border-t border-gray-100">
                                            <iframe
                                                srcDoc={preview.html}
                                                className="w-full border-0"
                                                style={{ height: "700px" }}
                                                title={`Preview for ${contact.fullName}`}
                                                sandbox="allow-same-origin"
                                            />
                                        </div>
                                    )}
                                </div>
                            )}

                            {!isLoading && !preview && (
                                <div className="flex items-center justify-center py-12 text-sm text-gray-400">
                                    Click &quot;Generate Previews&quot; to see this email
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {sampleContacts.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                    No recipients selected. Go back and select recipients to preview.
                </div>
            )}
        </div>
    );
}
