"use client";

import { useState } from "react";
import { Button, Card, Badge } from "@/components/ui";
import { Eye, EyeOff, Monitor, Smartphone, Paperclip } from "lucide-react";

interface EmailPreviewProps {
    subject: string;
    htmlContent: string;
    senderEmail?: string;
    recipientName?: string;
    recipientEmail?: string;
    fontSize?: string;
}

export function EmailPreview({
    subject,
    htmlContent,
    senderEmail,
    recipientName = "John Doe",
    recipientEmail = "john@example.com",
    attachments = [],
    fontSize = "18px",
}: EmailPreviewProps & { attachments?: File[] }) {
    const [viewMode, setViewMode] = useState<"desktop" | "mobile">("desktop");
    const [showAttachments, setShowAttachments] = useState(true);

    // CSS to ensure links are blue and underlined in the preview
    // We inject this style into the container
    const linkStyle = `
        .email-preview-content a {
            color: #0000EE;
            text-decoration: underline;
        }
    `;

    return (
        <div className="space-y-4">
            <style>{linkStyle}</style>
            <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">Preview</h3>
                <div className="flex gap-2">
                    <Button
                        variant={viewMode === "desktop" ? "primary" : "ghost"}
                        onClick={() => setViewMode("desktop")}
                        className="px-3 py-1.5 text-sm"
                    >
                        <Monitor size={14} />
                        Desktop
                    </Button>
                    <Button
                        variant={viewMode === "mobile" ? "primary" : "ghost"}
                        onClick={() => setViewMode("mobile")}
                        className="px-3 py-1.5 text-sm"
                    >
                        <Smartphone size={14} />
                        Mobile
                    </Button>
                </div>
            </div>

            <div
                className={`mx-auto transition-all duration-300 ${viewMode === "mobile" ? "max-w-[375px]" : "max-w-full"
                    }`}
            >
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-lg bg-white">
                    {/* Email Header */}
                    <div className="bg-gray-50 border-b border-gray-200 p-4">
                        <div className="space-y-2 text-sm">
                            <div className="flex">
                                <span className="text-gray-500 w-16">From:</span>
                                <span className="text-gray-900 font-medium">
                                    {senderEmail || "communications@yourcompany.com"}
                                </span>
                            </div>
                            <div className="flex">
                                <span className="text-gray-500 w-16">To:</span>
                                <span className="text-gray-900">
                                    {recipientName} &lt;{recipientEmail}&gt;
                                </span>
                            </div>
                            <div className="flex">
                                <span className="text-gray-500 w-16">Subject:</span>
                                <span className="text-gray-900 font-semibold">
                                    {subject || "(No subject)"}
                                </span>
                            </div>
                            {attachments.length > 0 && (
                                <div className="flex items-start">
                                    <span className="text-gray-500 w-16 pt-0.5">Attach:</span>
                                    <div className="flex flex-wrap gap-2">
                                        {attachments.map((file, idx) => (
                                            <div key={idx} className="flex items-center gap-1 bg-white border border-gray-200 px-2 py-0.5 rounded text-xs text-gray-700">
                                                <Paperclip size={10} className="text-gray-400" />
                                                <span className="max-w-[150px] truncate">{file.name}</span>
                                                <span className="text-gray-400">({(file.size / 1024).toFixed(0)}KB)</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Email Body */}
                    <div
                        className="p-6 min-h-[300px] email-preview-content"
                        style={{
                            fontFamily: "inherit",
                            fontSize: fontSize,
                            lineHeight: "1.6",
                        }}
                        dangerouslySetInnerHTML={{
                            __html: htmlContent || "<p style='color: #9ca3af;'>Email content will appear here...</p>",
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
