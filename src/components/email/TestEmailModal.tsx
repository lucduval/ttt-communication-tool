"use client";

import { useState } from "react";
import { Button, Card, Badge } from "@/components/ui";
import { Send, Loader2, CheckCircle, XCircle, Mail } from "lucide-react";

interface TestEmailModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSendTest: (email: string) => Promise<{ success: boolean; error?: string }>;
    subject: string;
    isSending?: boolean;
}

export function TestEmailModal({
    isOpen,
    onClose,
    onSendTest,
    subject,
    isSending = false,
}: TestEmailModalProps) {
    const [testEmail, setTestEmail] = useState("");
    const [result, setResult] = useState<{
        success: boolean;
        error?: string;
    } | null>(null);

    if (!isOpen) return null;

    const handleSend = async () => {
        if (!testEmail) return;
        setResult(null);
        const res = await onSendTest(testEmail);
        setResult(res);
    };

    const handleClose = () => {
        setTestEmail("");
        setResult(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="w-full max-w-md shadow-2xl">
                <div className="p-6 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center">
                            <Mail size={20} />
                        </div>
                        <div>
                            <h3 className="font-bold text-lg text-gray-900">Send Test Email</h3>
                            <p className="text-sm text-gray-500">
                                Preview how the email will look
                            </p>
                        </div>
                    </div>

                    <div className="bg-gray-50 p-3 rounded-lg text-sm">
                        <span className="text-gray-500">Subject:</span>{" "}
                        <span className="font-medium">[TEST] {subject || "(No subject)"}</span>
                    </div>

                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">
                            Send test to
                        </label>
                        <input
                            type="email"
                            value={testEmail}
                            onChange={(e) => setTestEmail(e.target.value)}
                            placeholder="your@email.com"
                            className="w-full px-4 py-3 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-[#1E3A5F]/20"
                            disabled={isSending}
                        />
                    </div>

                    {result && (
                        <div
                            className={`p-3 rounded-lg flex items-center gap-2 ${result.success
                                    ? "bg-green-50 text-green-700"
                                    : "bg-red-50 text-red-700"
                                }`}
                        >
                            {result.success ? (
                                <>
                                    <CheckCircle size={18} />
                                    <span>Test email sent successfully!</span>
                                </>
                            ) : (
                                <>
                                    <XCircle size={18} />
                                    <span>{result.error || "Failed to send test email"}</span>
                                </>
                            )}
                        </div>
                    )}

                    <div className="flex gap-3 pt-2">
                        <Button
                            variant="secondary"
                            onClick={handleClose}
                            className="flex-1"
                            disabled={isSending}
                        >
                            {result?.success ? "Done" : "Cancel"}
                        </Button>
                        {!result?.success && (
                            <Button
                                onClick={handleSend}
                                className="flex-1"
                                disabled={isSending || !testEmail}
                            >
                                {isSending ? (
                                    <>
                                        <Loader2 size={16} className="animate-spin" />
                                        Sending...
                                    </>
                                ) : (
                                    <>
                                        <Send size={16} />
                                        Send Test
                                    </>
                                )}
                            </Button>
                        )}
                    </div>
                </div>
            </Card>
        </div>
    );
}
