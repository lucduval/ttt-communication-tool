"use client";

import { ExternalLink } from "lucide-react";
import type { Doc } from "@/../convex/_generated/dataModel";

interface WhatsAppPreviewProps {
    template: Doc<"whatsappTemplates"> | null;
    variableValues: Record<string, string>;
    recipientName?: string;
    recipientPhone?: string;
}

export function WhatsAppPreview({
    template,
    variableValues,
    recipientName = "John Doe",
    recipientPhone = "+27 82 123 4567",
}: WhatsAppPreviewProps) {
    // Replace variables in template body with actual values
    const renderMessage = () => {
        if (!template) return "Select a template to preview the message.";

        let message = template.body;

        // Replace each variable with its value or placeholder
        template.variables.forEach((variable) => {
            const value = variableValues[variable] || `[${variable}]`;
            message = message.replace(new RegExp(`\\{\\{${variable}\\}\\}`, "g"), value);
        });

        // Auto-replace common variables with recipient data
        const safeName = recipientName || "John Doe";
        message = message.replace(/\{\{name\}\}/gi, safeName);
        message = message.replace(/\{\{first_name\}\}/gi, safeName.split(" ")[0]);

        return message;
    };

    // Resolve the button URL by substituting {{1}} with the value of the
    // mapped Dynamics variable. Returns the URL exactly as it will be sent —
    // useful for confirming the dynamic link is wired correctly before a
    // test send.
    const resolveButtonUrl = (): string | null => {
        if (!template || template.buttonType !== "url" || !template.buttonUrl) return null;
        if (!template.buttonUrl.includes("{{1}}")) return template.buttonUrl;
        const varName = template.buttonUrlVariable;
        if (!varName) return template.buttonUrl;
        const value = variableValues[varName];
        if (!value) return template.buttonUrl.replace("{{1}}", `[${varName}]`);
        return template.buttonUrl.replace("{{1}}", value);
    };

    const buttonUrl = resolveButtonUrl();
    const hasButton = template?.buttonType === "url" && !!template.buttonText && !!template.buttonUrl;
    const isDynamicButton = !!template?.buttonUrl?.includes("{{1}}");

    return (
        <div className="flex justify-center">
            {/* Phone Mockup */}
            <div className="w-72 bg-gray-900 rounded-[2.5rem] p-3 shadow-2xl">
                <div className="bg-[#ECE5DD] rounded-[2rem] overflow-hidden">
                    {/* WhatsApp Header */}
                    <div className="bg-[#075E54] text-white px-4 py-3 flex items-center gap-3">
                        <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center text-gray-600 font-bold text-sm">
                            B
                        </div>
                        <div className="flex-1">
                            <p className="font-semibold text-sm">Business Name</p>
                            <p className="text-xs text-green-200">online</p>
                        </div>
                    </div>

                    {/* Chat Area */}
                    <div className="min-h-[320px] p-3 space-y-3">
                        {/* Incoming Message Bubble */}
                        <div className="flex justify-start">
                            <div className="bg-white rounded-lg rounded-tl-none max-w-[85%] shadow-sm overflow-hidden">
                                <div className="px-3 py-2">
                                    <p className="text-sm text-gray-800 whitespace-pre-wrap">
                                        {renderMessage()}
                                    </p>
                                    <p className="text-[10px] text-gray-400 text-right mt-1">
                                        {new Date().toLocaleTimeString([], {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}
                                    </p>
                                </div>
                                {hasButton && (
                                    <div
                                        className="border-t border-gray-100 px-3 py-2 flex items-center justify-center gap-1.5 text-[#00A884] text-sm font-medium"
                                        title={buttonUrl ?? undefined}
                                    >
                                        <ExternalLink size={14} />
                                        {template!.buttonText}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Resolved button URL — separate from the bubble so the
                        full URL is visible without truncating the chat bubble. */}
                    {hasButton && buttonUrl && (
                        <div className="bg-white px-4 py-2 border-t border-gray-200">
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">
                                {isDynamicButton ? "Dynamic link" : "Link"}
                            </p>
                            <p className="text-xs font-mono text-gray-700 break-all">{buttonUrl}</p>
                        </div>
                    )}

                    {/* Recipient Info */}
                    <div className="bg-white px-4 py-2 border-t border-gray-200">
                        <p className="text-xs text-gray-500">Preview for:</p>
                        <p className="text-sm font-medium text-gray-800">{recipientName}</p>
                        <p className="text-xs text-gray-400">{recipientPhone}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
