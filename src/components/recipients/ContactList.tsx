"use client";

import { Badge } from "@/components/ui";
import { Mail, MessageSquare, MoreVertical, User } from "lucide-react";

export interface Contact {
    id: string;
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    internationalPhone: string | null;
    isActive: boolean;
    clientType: string | null;
    marketingPreferences: {
        tax: boolean;
        accounting: boolean;
        insurance: boolean;
    };
    whatsappOptIn: boolean;
    emailNotifications: boolean;
    smsNotifications: boolean;
    createdOn: string;
    modifiedOn: string;
}

interface ContactListProps {
    contacts: Contact[];
    isLoading?: boolean;
    selectedIds?: Set<string>;
    onSelectionChange?: (selectedIds: Set<string>) => void;
    showSelection?: boolean;
}

export function ContactList({
    contacts,
    isLoading,
    selectedIds = new Set(),
    onSelectionChange,
    showSelection = false,
}: ContactListProps) {
    const toggleSelection = (id: string) => {
        if (!onSelectionChange) return;
        const newSelection = new Set(selectedIds);
        if (newSelection.has(id)) {
            newSelection.delete(id);
        } else {
            newSelection.add(id);
        }
        onSelectionChange(newSelection);
    };

    const toggleAll = () => {
        if (!onSelectionChange) return;
        if (selectedIds.size === contacts.length) {
            onSelectionChange(new Set());
        } else {
            onSelectionChange(new Set(contacts.map((c) => c.id)));
        }
    };

    if (isLoading) {
        return (
            <div className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="p-8 text-center text-gray-400">
                    <div className="animate-pulse flex flex-col items-center gap-3">
                        <div className="w-8 h-8 bg-gray-200 rounded-full" />
                        <div className="h-4 bg-gray-200 rounded w-32" />
                    </div>
                </div>
            </div>
        );
    }

    if (contacts.length === 0) {
        return (
            <div className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="p-8 text-center text-gray-400">
                    <User size={32} className="mx-auto mb-2 opacity-50" />
                    <p>No contacts found</p>
                </div>
            </div>
        );
    }

    return (
        <div className="border border-gray-100 rounded-lg overflow-hidden overflow-x-auto">
            <table className="w-full text-left text-sm">
                <thead className="bg-[#F5F7FA] border-b border-gray-200 text-[#1E3A5F] font-bold">
                    <tr>
                        {showSelection && (
                            <th className="px-4 py-4 w-12">
                                <input
                                    type="checkbox"
                                    checked={selectedIds.size === contacts.length && contacts.length > 0}
                                    onChange={toggleAll}
                                    className="rounded border-gray-300"
                                />
                            </th>
                        )}
                        <th className="px-4 py-4">Name</th>
                        <th className="px-4 py-4">Contact</th>
                        <th className="px-4 py-4">Type</th>
                        <th className="px-4 py-4">Channels</th>
                        <th className="px-4 py-4 w-12"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                    {contacts.map((contact) => (
                        <tr
                            key={contact.id}
                            className={`hover:bg-gray-50 transition-colors ${selectedIds.has(contact.id) ? "bg-blue-50" : ""
                                }`}
                        >
                            {showSelection && (
                                <td className="px-4 py-4">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(contact.id)}
                                        onChange={() => toggleSelection(contact.id)}
                                        className="rounded border-gray-300"
                                    />
                                </td>
                            )}
                            <td className="px-4 py-4">
                                <div className="font-medium text-gray-900">
                                    {contact.fullName}
                                </div>
                            </td>
                            <td className="px-4 py-4">
                                <div className="space-y-1">
                                    {contact.email && (
                                        <div className="text-gray-600 text-xs flex items-center gap-1">
                                            <Mail size={12} className="text-gray-400" />
                                            {contact.email}
                                        </div>
                                    )}
                                    {(contact.internationalPhone || contact.phone) && (
                                        <div className="text-gray-600 text-xs flex items-center gap-1">
                                            <MessageSquare size={12} className="text-gray-400" />
                                            {contact.internationalPhone || contact.phone}
                                        </div>
                                    )}
                                </div>
                            </td>
                            <td className="px-4 py-4">
                                <Badge
                                    status={
                                        contact.clientType === "1" ? "info" : "default"
                                    }
                                >
                                    {contact.clientType === "1" ? "Business" : "Individual"}
                                </Badge>
                            </td>
                            <td className="px-4 py-4">
                                <div className="flex gap-1">
                                    {contact.emailNotifications && contact.email && (
                                        <span
                                            className="w-6 h-6 bg-blue-100 text-blue-600 rounded flex items-center justify-center"
                                            title="Email enabled"
                                        >
                                            <Mail size={12} />
                                        </span>
                                    )}
                                    {contact.whatsappOptIn && contact.phone && (
                                        <span
                                            className="w-6 h-6 bg-green-100 text-green-600 rounded flex items-center justify-center"
                                            title="WhatsApp opted in"
                                        >
                                            <MessageSquare size={12} />
                                        </span>
                                    )}
                                </div>
                            </td>
                            <td className="px-4 py-4 text-right">
                                <button className="p-1 hover:bg-gray-100 rounded">
                                    <MoreVertical size={16} className="text-gray-400" />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
