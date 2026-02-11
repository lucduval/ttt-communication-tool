"use client";

import { useState } from "react";
import { Button, Card, Badge } from "@/components/ui";
import { Send, Loader2, CheckCircle, XCircle, MessageSquare } from "lucide-react";

interface TestWhatsAppModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSendTest: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>;
    templateName: string;
    isSending?: boolean;
}

export function TestWhatsAppModal({
    isOpen,
    onClose,
    onSendTest,
    templateName,
    isSending = false,
}: TestWhatsAppModalProps) {
    const [phoneNumber, setPhoneNumber] = useState("");
    const [result, setResult] = useState<{
        success: boolean;
        error?: string;
    } | null>(null);

    if (!isOpen) return null;

    const validatePhoneNumber = (number: string) => {
        // Must start with 27 and be 11 digits total
        return /^27\d{9}$/.test(number);
    };

    const handleSend = async () => {
        if (!validatePhoneNumber(phoneNumber)) return;
        setResult(null);
        // Ensure only numbers are sent? The validation ensures it's 27xxxxxxxxx
        const res = await onSendTest(phoneNumber);
        setResult(res);
    };

    const handleClose = () => {
        setPhoneNumber("");
        setResult(null);
        onClose();
    };

    const isValid = validatePhoneNumber(phoneNumber);

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="w-full max-w-md shadow-2xl">
                <div className="p-6 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-green-100 text-green-600 rounded-lg flex items-center justify-center">
                            <MessageSquare size={20} />
                        </div>
                        <div>
                            <h3 className="font-bold text-lg text-gray-900">Send Test WhatsApp</h3>
                            <p className="text-sm text-gray-500">
                                Send a test message to your phone
                            </p>
                        </div>
                    </div>

                    <div className="bg-gray-50 p-3 rounded-lg text-sm">
                        <span className="text-gray-500">Template:</span>{" "}
                        <span className="font-medium">{templateName || "(No template selected)"}</span>
                    </div>

                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">
                            Mobile Number (International Format)
                        </label>
                        <input
                            type="text"
                            value={phoneNumber}
                            onChange={(e) => {
                                // Allow only numbers
                                const val = e.target.value.replace(/\D/g, "");
                                setPhoneNumber(val);
                            }}
                            placeholder="27821234567"
                            className={`w-full px-4 py-3 border rounded-lg outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 ${!isValid && phoneNumber.length > 0 ? "border-red-300 bg-red-50" : "border-gray-200"
                                }`}
                            disabled={isSending}
                        />
                        <p className={`text-xs mt-1 ${!isValid && phoneNumber.length > 0 ? "text-red-500" : "text-gray-400"}`}>
                            Must start with 27 and contain 11 digits (e.g. 27821234567)
                        </p>
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
                                    <span>Test message sent successfully!</span>
                                </>
                            ) : (
                                <>
                                    <XCircle size={18} />
                                    <span>{result.error || "Failed to send test message"}</span>
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
                                disabled={isSending || !isValid}
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
