"use client";

import { Button, Card } from "@/components/ui";
import { AlertTriangle, X } from "lucide-react";

interface ConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isLoading?: boolean;
    variant?: "danger" | "warning" | "info";
}

export function ConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    isLoading = false,
    variant = "warning",
}: ConfirmationModalProps) {
    if (!isOpen) return null;

    const getIconColor = () => {
        switch (variant) {
            case "danger": return "text-red-500 bg-red-50";
            case "warning": return "text-amber-500 bg-amber-50";
            case "info": return "text-blue-500 bg-blue-50";
            default: return "text-gray-500 bg-gray-50";
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
            <Card className="w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className={`p-3 rounded-full flex-shrink-0 ${getIconColor()}`}>
                            <AlertTriangle size={24} />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-lg font-bold text-gray-900 mb-1">{title}</h3>
                            <p className="text-sm text-gray-500">{description}</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                            disabled={isLoading}
                        >
                            <X size={20} />
                        </button>
                    </div>

                    <div className="flex gap-3 mt-6 justify-end">
                        <Button
                            variant="secondary"
                            onClick={onClose}
                            disabled={isLoading}
                        >
                            {cancelLabel}
                        </Button>
                        <Button
                            onClick={onConfirm}
                            disabled={isLoading}
                            variant={variant === "danger" ? "danger" : "primary"}
                        >
                            {isLoading ? "Processing..." : confirmLabel}
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}
