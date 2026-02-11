"use client";

import { Button, Card } from "@/components/ui";
import { X, CheckCircle, Monitor, Smartphone, Paperclip } from "lucide-react";
import { useState } from "react";

interface LivePreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    subject: string;
    htmlContent: string;
    senderEmail?: string;
    recipientName?: string;
    recipientEmail?: string;
    attachments?: File[];
}

export function LivePreviewModal({
    isOpen,
    onClose,
    subject,
    htmlContent,
    senderEmail,
    recipientName = "Recipient Name",
    recipientEmail = "recipient@example.com",
    attachments = [],
}: LivePreviewModalProps) {
    const [viewMode, setViewMode] = useState<"desktop" | "mobile">("desktop");

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto p-4">
            <Card className="w-full max-w-4xl shadow-2xl relative flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-gray-100 sticky top-0 bg-white z-10 rounded-t-lg">
                    <div>
                        <h3 className="text-xl font-bold text-gray-900">Email Preview</h3>
                        <p className="text-sm text-gray-500">See how your email will look to recipients</p>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="flex bg-gray-100 p-1 rounded-lg">
                            <button
                                onClick={() => setViewMode("desktop")}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-all ${viewMode === "desktop"
                                    ? "bg-white shadow text-gray-900"
                                    : "text-gray-500 hover:text-gray-900"
                                    }`}
                            >
                                <Monitor size={16} />
                                Desktop
                            </button>
                            <button
                                onClick={() => setViewMode("mobile")}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-all ${viewMode === "mobile"
                                    ? "bg-white shadow text-gray-900"
                                    : "text-gray-500 hover:text-gray-900"
                                    }`}
                            >
                                <Smartphone size={16} />
                                Mobile
                            </button>
                        </div>

                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500 hover:text-gray-900"
                        >
                            <X size={24} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
                    <div
                        className={`mx-auto transition-all duration-300 ${viewMode === "mobile" ? "max-w-[375px]" : "max-w-full"
                            }`}
                    >
                        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                            {/* Email Header Info */}
                            <div className="bg-gray-50 border-b border-gray-200 p-4 space-y-2 text-sm">
                                <div className="flex">
                                    <span className="text-gray-500 w-20">From:</span>
                                    <span className="text-gray-900 font-medium">
                                        {senderEmail || "communications@yourcompany.com"}
                                    </span>
                                </div>
                                <div className="flex">
                                    <span className="text-gray-500 w-20">To:</span>
                                    <span className="text-gray-900">
                                        {recipientName} &lt;{recipientEmail}&gt;
                                    </span>
                                </div>
                                <div className="flex">
                                    <span className="text-gray-500 w-20">Subject:</span>
                                    <span className="text-gray-900 font-semibold">
                                        {subject || "(No subject)"}
                                    </span>
                                </div>
                                {attachments.length > 0 && (
                                    <div className="flex items-start">
                                        <span className="text-gray-500 w-20 pt-1">Attachments:</span>
                                        <div className="flex flex-wrap gap-2">
                                            {attachments.map((file, idx) => (
                                                <div key={idx} className="flex items-center gap-1 bg-white border border-gray-200 px-2 py-1 rounded text-xs text-gray-700">
                                                    <Paperclip size={12} className="text-gray-400" />
                                                    <span className="max-w-[150px] truncate">{file.name}</span>
                                                    <span className="text-gray-400">({(file.size / 1024).toFixed(0)}KB)</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Email Body */}
                            <div
                                className="p-8 min-h-[400px] bg-white"
                                style={{
                                    fontFamily: "Arial, sans-serif",
                                    fontSize: "16px",
                                    lineHeight: "1.6",
                                    color: "#333"
                                }}
                                dangerouslySetInnerHTML={{
                                    __html: htmlContent || "<p style='color: #9ca3af; font-style: italic;'>Start typing in the editor to see your email content here...</p>"
                                }}
                            />
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 bg-white rounded-b-lg flex justify-end">
                    <Button onClick={onClose}>
                        Close Preview
                    </Button>
                </div>
            </Card>
        </div>
    );
}
