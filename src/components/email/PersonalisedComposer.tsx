"use client";

import { useState } from "react";
import { Info } from "lucide-react";

interface PersonalisedComposerProps {
    systemPrompt: string;
    onSystemPromptChange: (value: string) => void;
    userPrompt: string;
    onUserPromptChange: (value: string) => void;
    subject: string;
    onSubjectChange: (value: string) => void;
}

export const DEFAULT_SYSTEM_PROMPT =
    "You are a friendly and professional tax advisor at TTT Group. Write warm but concise emails that are easy to understand. Avoid jargon. Do NOT invent or change any numbers — use the exact figures provided.";

export const DEFAULT_USER_PROMPT =
    "Open the intro by referencing the start of the new tax year as a full year of opportunity to structure finances strategically and reduce tax. Mention that TTT Financial Group believes in proactive — not reactive — tax planning, and in using every available mechanism to legally minimise tax and accelerate long-term wealth creation. Reference that the scenarios were prepared using figures from the client's most recent ITA34. Use bullet points to show what the three scenarios demonstrate: how much tax they could save this year, what the real net cost would be after SARS effectively subsidises part of their contribution, and the long-term wealth impact of acting now rather than later. Mention that for many clients the outcome is compelling — redirecting money that would have gone to tax into a growing retirement asset. Close with a warm invitation to walk through the numbers and show exactly how this could work in their favour for the upcoming tax year.";

export const DEFAULT_SUBJECT =
    "{firstName}, here's how to maximise your tax refund";

export function PersonalisedComposer({
    systemPrompt,
    onSystemPromptChange,
    userPrompt,
    onUserPromptChange,
    subject,
    onSubjectChange,
}: PersonalisedComposerProps) {
    const [activeField, setActiveField] = useState<"system" | "user" | "subject">("user");

    const mergeFields = [
        { label: "{firstName}", group: "Contact" },
        { label: "{yearOfAssessment}", group: "Tax" },
    ];

    const insertMergeField = (field: string) => {
        if (activeField === "system") {
            onSystemPromptChange(systemPrompt + field);
        } else if (activeField === "user") {
            onUserPromptChange(userPrompt + field);
        } else {
            onSubjectChange(subject + field);
        }
    };

    return (
        <div className="space-y-6">
            {/* Subject Line */}
            <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Email Subject Line <span className="text-red-500">*</span>
                </label>
                <input
                    type="text"
                    value={subject}
                    onChange={(e) => onSubjectChange(e.target.value)}
                    onFocus={() => setActiveField("subject")}
                    placeholder="e.g. {firstName}, here's how to maximise your 2025 tax refund"
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20"
                />
                <p className="mt-1 text-xs text-gray-400">
                    Use {"{firstName}"} to personalise. Other fields are auto-injected into the email body.
                </p>
            </div>

            {/* Merge field chips */}
            <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Insert Merge Fields
                </label>
                <div className="flex flex-wrap gap-2">
                    {mergeFields.map((f) => (
                        <button
                            key={f.label}
                            type="button"
                            onClick={() => insertMergeField(f.label)}
                            className="px-3 py-1.5 text-xs font-mono bg-blue-50 text-blue-700 border border-blue-200 rounded-full hover:bg-blue-100 transition-colors"
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* AI System Prompt */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <label className="block text-sm font-semibold text-gray-700">
                            AI Tone &amp; Style
                        </label>
                        <div className="group relative">
                            <Info size={14} className="text-gray-400" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 bg-gray-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                Controls the overall voice and personality of the AI-generated copy. The financial numbers are always calculated exactly — AI only writes the surrounding text.
                            </div>
                        </div>
                    </div>
                    {systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
                        <button
                            type="button"
                            onClick={() => onSystemPromptChange(DEFAULT_SYSTEM_PROMPT)}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                            Reset to default
                        </button>
                    )}
                </div>
                <textarea
                    value={systemPrompt}
                    onChange={(e) => onSystemPromptChange(e.target.value)}
                    onFocus={() => setActiveField("system")}
                    rows={3}
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 text-sm"
                />
            </div>

            {/* AI User Prompt */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <label className="block text-sm font-semibold text-gray-700">
                            AI Instructions <span className="text-red-500">*</span>
                        </label>
                        <div className="group relative">
                            <Info size={14} className="text-gray-400" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 bg-gray-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                Tell the AI how to frame the RA options. For example: emphasise growth potential, mention tax season deadlines, reference their employer, etc.
                            </div>
                        </div>
                    </div>
                    {userPrompt !== DEFAULT_USER_PROMPT && (
                        <button
                            type="button"
                            onClick={() => onUserPromptChange(DEFAULT_USER_PROMPT)}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                            Reset to default
                        </button>
                    )}
                </div>
                <textarea
                    value={userPrompt}
                    onChange={(e) => onUserPromptChange(e.target.value)}
                    onFocus={() => setActiveField("user")}
                    rows={5}
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 text-sm"
                />
            </div>

            {/* Template Preview */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Email Template Structure</h4>
                <div className="space-y-2">
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-[#1E3A5F]" />
                        <span className="text-sm text-gray-600">Header with TTT branding + year</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-gray-400" />
                        <span className="text-sm text-gray-600">AI-written greeting + intro</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-gray-300" />
                        <span className="text-sm text-gray-600">Current situation stats (income, RA, tax)</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-blue-500" />
                        <span className="text-sm text-gray-600">Option A card — Moderate Top-Up (50% headroom)</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-green-500" />
                        <span className="text-sm text-gray-600">Option B card — Accelerated Growth (80% headroom)</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-amber-500" />
                        <span className="text-sm text-gray-600">Option C card — Fully Optimised + Call TTT CTA</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full bg-gray-300" />
                        <span className="text-sm text-gray-600">Comparison table + disclaimer + footer</span>
                    </div>
                </div>
                <p className="mt-3 text-xs text-gray-400">
                    All monetary figures are calculated by the SA tax engine. AI generates only the conversational text.
                </p>
            </div>
        </div>
    );
}
