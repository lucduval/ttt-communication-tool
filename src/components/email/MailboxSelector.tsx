"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ChevronDown, Mail, Loader2 } from "lucide-react";

interface MailboxInfo {
    id: string;
    displayName: string;
    mail: string;
}

interface MailboxSelectorProps {
    selectedMailbox: string | null;
    onMailboxChange: (mailbox: string) => void;
    disabled?: boolean;
}

export function MailboxSelector({
    selectedMailbox,
    onMailboxChange,
    disabled = false,
}: MailboxSelectorProps) {
    const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isOpen, setIsOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
    const buttonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const getAvailableMailboxes = useAction(api.actions.graph_mailboxes.getAvailableMailboxes);

    useEffect(() => {
        const loadMailboxes = async () => {
            try {
                setIsLoading(true);
                setError(null);
                const result = await getAvailableMailboxes();
                setMailboxes(result.mailboxes);

                // Auto-select default mailbox if none selected
                if (!selectedMailbox && result.defaultMailbox) {
                    onMailboxChange(result.defaultMailbox);
                } else if (!selectedMailbox && result.mailboxes.length > 0) {
                    onMailboxChange(result.mailboxes[0].mail);
                }
            } catch (err) {
                console.error("Failed to load mailboxes:", err);
                setError("Failed to load mailboxes");
            } finally {
                setIsLoading(false);
            }
        };

        loadMailboxes();
    }, [getAvailableMailboxes, selectedMailbox, onMailboxChange]);

    // Update dropdown position when opened
    useEffect(() => {
        if (isOpen && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setDropdownPosition({
                top: rect.bottom + window.scrollY + 4,
                left: rect.left + window.scrollX,
                width: rect.width,
            });
        }
    }, [isOpen]);

    // Close on click outside
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (
            dropdownRef.current &&
            !dropdownRef.current.contains(e.target as Node) &&
            buttonRef.current &&
            !buttonRef.current.contains(e.target as Node)
        ) {
            setIsOpen(false);
        }
    }, []);

    // Close on scroll
    const handleScroll = useCallback(() => {
        if (isOpen) {
            setIsOpen(false);
        }
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            document.addEventListener("mousedown", handleClickOutside);
            window.addEventListener("scroll", handleScroll, true);
            return () => {
                document.removeEventListener("mousedown", handleClickOutside);
                window.removeEventListener("scroll", handleScroll, true);
            };
        }
    }, [isOpen, handleClickOutside, handleScroll]);

    const selectedMailboxInfo = mailboxes.find((m) => m.mail === selectedMailbox);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 border border-gray-200 rounded-lg bg-gray-50">
                <Loader2 size={16} className="animate-spin text-gray-400" />
                <span className="text-gray-500">Loading mailboxes...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="px-4 py-3 border border-red-200 rounded-lg bg-red-50">
                <span className="text-red-600 text-sm">{error}</span>
            </div>
        );
    }

    if (mailboxes.length === 0) {
        return (
            <div className="px-4 py-3 border border-amber-200 rounded-lg bg-amber-50">
                <span className="text-amber-700 text-sm">
                    No shared mailboxes configured. Add SHARED_MAILBOX_ADDRESSES to your environment.
                </span>
            </div>
        );
    }

    // If only one mailbox, show it as read-only
    if (mailboxes.length === 1) {
        return (
            <div className="flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg bg-gray-50">
                <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                    <Mail size={14} />
                </div>
                <div>
                    <div className="text-sm font-medium text-gray-900">
                        {mailboxes[0].displayName}
                    </div>
                    <div className="text-xs text-gray-500">{mailboxes[0].mail}</div>
                </div>
            </div>
        );
    }

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                disabled={disabled}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 border rounded-lg transition-all ${isOpen
                        ? "border-[#1E3A5F] ring-2 ring-[#1E3A5F]/20"
                        : "border-gray-200 hover:border-gray-300"
                    } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
            >
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                        <Mail size={14} />
                    </div>
                    <div className="text-left">
                        <div className="text-sm font-medium text-gray-900">
                            {selectedMailboxInfo?.displayName || "Select a mailbox"}
                        </div>
                        {selectedMailboxInfo && (
                            <div className="text-xs text-gray-500">
                                {selectedMailboxInfo.mail}
                            </div>
                        )}
                    </div>
                </div>
                <ChevronDown
                    size={18}
                    className={`text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                />
            </button>

            {/* Portal for dropdown - renders outside Card */}
            {isOpen && typeof document !== "undefined" &&
                createPortal(
                    <div
                        ref={dropdownRef}
                        className="fixed bg-white border border-gray-200 rounded-lg shadow-xl z-[101] overflow-hidden"
                        style={{
                            top: dropdownPosition.top,
                            left: dropdownPosition.left,
                            width: dropdownPosition.width,
                        }}
                    >
                        {mailboxes.map((mailbox) => (
                            <button
                                key={mailbox.id}
                                type="button"
                                onClick={() => {
                                    onMailboxChange(mailbox.mail);
                                    setIsOpen(false);
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${selectedMailbox === mailbox.mail
                                        ? "bg-blue-50 border-l-2 border-[#1E3A5F]"
                                        : ""
                                    }`}
                            >
                                <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                                    <Mail size={14} />
                                </div>
                                <div className="text-left">
                                    <div className="text-sm font-medium text-gray-900">
                                        {mailbox.displayName}
                                    </div>
                                    <div className="text-xs text-gray-500">{mailbox.mail}</div>
                                </div>
                            </button>
                        ))}
                    </div>,
                    document.body
                )}
        </>
    );
}
