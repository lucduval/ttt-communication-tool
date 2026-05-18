"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ChevronDown, Mail, Loader2, Plus } from "lucide-react";

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
    const [isAdmin, setIsAdmin] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isOpen, setIsOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
    const [showCustomInput, setShowCustomInput] = useState(false);
    const [customAddress, setCustomAddress] = useState("");
    const [customError, setCustomError] = useState<string | null>(null);
    const [verifyingCustom, setVerifyingCustom] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const getAvailableMailboxes = useAction(api.actions.graph_mailboxes.getAvailableMailboxes);
    const verifyMailboxAccess = useAction(api.actions.graph_mailboxes.verifyMailboxAccess);

    useEffect(() => {
        const loadMailboxes = async () => {
            try {
                setIsLoading(true);
                setError(null);
                const result = await getAvailableMailboxes();
                setMailboxes(result.mailboxes);
                setIsAdmin(result.isAdmin);

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

    // Close on page scroll, but ignore scrolls that happen *inside* the dropdown.
    const handleScroll = useCallback((e: Event) => {
        if (!isOpen) return;
        if (
            dropdownRef.current &&
            e.target instanceof Node &&
            dropdownRef.current.contains(e.target)
        ) {
            return;
        }
        setIsOpen(false);
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
    const selectedIsCustom =
        !!selectedMailbox && !selectedMailboxInfo && isAdmin;

    const submitCustomAddress = async () => {
        const trimmed = customAddress.trim();
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(trimmed)) {
            setCustomError("Please enter a valid email address");
            return;
        }

        setVerifyingCustom(true);
        setCustomError(null);
        try {
            const result = await verifyMailboxAccess({ mailboxAddress: trimmed });
            if (!result.hasAccess) {
                setCustomError(result.error || "Unable to send from this address");
                return;
            }
            onMailboxChange(trimmed);
            setShowCustomInput(false);
            setIsOpen(false);
            setCustomAddress("");
        } catch (err) {
            setCustomError(err instanceof Error ? err.message : "Verification failed");
        } finally {
            setVerifyingCustom(false);
        }
    };

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

    // Non-admins with a single available mailbox: show read-only (no choices to make).
    // Admins always get the dropdown so they can pick a custom tenant address.
    if (mailboxes.length === 1 && !isAdmin) {
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
                            {selectedMailboxInfo?.displayName ||
                                (selectedIsCustom ? "Custom address" : "Select a mailbox")}
                        </div>
                        {(selectedMailboxInfo || selectedIsCustom) && (
                            <div className="text-xs text-gray-500">
                                {selectedMailboxInfo?.mail || selectedMailbox}
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
                        className="fixed bg-white border border-gray-200 rounded-lg shadow-xl z-[101] max-h-64 overflow-y-auto"
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
                                    setShowCustomInput(false);
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
                        {isAdmin && (
                            <div className="border-t border-gray-100">
                                {showCustomInput ? (
                                    <div className="px-4 py-3 space-y-2">
                                        <label className="text-xs font-medium text-gray-700">
                                            Custom tenant address
                                        </label>
                                        <input
                                            type="email"
                                            autoFocus
                                            value={customAddress}
                                            onChange={(e) => {
                                                setCustomAddress(e.target.value);
                                                setCustomError(null);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    submitCustomAddress();
                                                } else if (e.key === "Escape") {
                                                    setShowCustomInput(false);
                                                    setCustomError(null);
                                                }
                                            }}
                                            placeholder="name@yourtenant.com"
                                            disabled={verifyingCustom}
                                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 focus:border-[#1E3A5F]"
                                        />
                                        {customError && (
                                            <div className="text-xs text-red-600">{customError}</div>
                                        )}
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={submitCustomAddress}
                                                disabled={verifyingCustom || !customAddress.trim()}
                                                className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-[#1E3A5F] rounded-md hover:bg-[#152a48] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                            >
                                                {verifyingCustom && (
                                                    <Loader2 size={14} className="animate-spin" />
                                                )}
                                                {verifyingCustom ? "Verifying..." : "Use this address"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowCustomInput(false);
                                                    setCustomError(null);
                                                }}
                                                disabled={verifyingCustom}
                                                className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowCustomInput(true);
                                            setCustomAddress(
                                                selectedIsCustom && selectedMailbox
                                                    ? selectedMailbox
                                                    : ""
                                            );
                                        }}
                                        className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${selectedIsCustom
                                            ? "bg-blue-50 border-l-2 border-[#1E3A5F]"
                                            : ""
                                            }`}
                                    >
                                        <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                                            <Plus size={14} />
                                        </div>
                                        <div className="text-left">
                                            <div className="text-sm font-medium text-gray-900">
                                                {selectedIsCustom ? "Custom address" : "Use a custom address..."}
                                            </div>
                                            <div className="text-xs text-gray-500">
                                                {selectedIsCustom && selectedMailbox
                                                    ? selectedMailbox
                                                    : "Send from any address in your tenant"}
                                            </div>
                                        </div>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>,
                    document.body
                )}
        </>
    );
}
