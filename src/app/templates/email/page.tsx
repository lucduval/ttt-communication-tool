"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Plus, Edit2, Trash2, Mail, Globe, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function EmailTemplatesPage() {
    const templates = useQuery(api.emailTemplates.list);
    const currentUser = useQuery(api.users.getCurrentUser);
    const deleteTemplate = useMutation(api.emailTemplates.remove);
    const setVisibility = useMutation(api.emailTemplates.setVisibility);

    const [togglingId, setTogglingId] = useState<string | null>(null);

    const isAdmin = currentUser?.role === "admin";
    const currentUserId = currentUser?._id;

    const canEditTemplate = (template: { createdBy: string }) =>
        isAdmin || template.createdBy === currentUserId;

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        if (confirm("Are you sure you want to delete this template?")) {
            try {
                await deleteTemplate({ id: id as any });
            } catch (error) {
                console.error(error);
                alert("Failed to delete template");
            }
        }
    };

    const handleToggleVisibility = async (
        id: string,
        current: "private" | "shared" | undefined,
        e: React.MouseEvent
    ) => {
        e.preventDefault();
        const next = current === "shared" ? "private" : "shared";
        setTogglingId(id);
        try {
            await setVisibility({ id: id as any, visibility: next });
        } catch (error) {
            console.error(error);
            alert("Failed to update visibility");
        } finally {
            setTogglingId(null);
        }
    };

    if (templates === undefined || currentUser === undefined) {
        return <div className="p-8 text-center">Loading templates...</div>;
    }

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-[#1E3A5F]">Email Templates</h1>
                    <p className="text-gray-500 mt-2">Manage your email templates for campaigns</p>
                </div>
                <Link href="/templates/email/new">
                    <Button className="gap-2">
                        <Plus size={18} />
                        Create Template
                    </Button>
                </Link>
            </div>

            {templates.length === 0 ? (
                <Card className="p-12 text-center bg-gray-50 border-dashed">
                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Mail className="text-blue-600" size={32} />
                    </div>
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No templates yet</h3>
                    <p className="text-gray-500 mb-6 max-w-md mx-auto">
                        Create your first email template to reuse content across your marketing campaigns.
                    </p>
                    <Link href="/templates/email/new">
                        <Button variant="secondary">Create First Template</Button>
                    </Link>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {templates.map((template) => {
                        const isOwner = template.createdBy === currentUserId;
                        const canEdit = isAdmin || isOwner;
                        const isShared = template.visibility !== "private";
                        const isToggling = togglingId === template._id;

                        return (
                            <Card key={template._id} className="hover:shadow-lg transition-shadow duration-200">
                                <div className="p-6 flex flex-col h-full">
                                    <div className="flex-1">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-2 bg-blue-50 rounded text-blue-600">
                                                <Mail size={20} />
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {/* Visibility badge */}
                                                <span
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                                        isShared
                                                            ? "bg-green-50 text-green-700"
                                                            : "bg-gray-100 text-gray-500"
                                                    }`}
                                                >
                                                    {isShared ? (
                                                        <Globe size={11} />
                                                    ) : (
                                                        <Lock size={11} />
                                                    )}
                                                    {isShared ? "Shared" : "Private"}
                                                </span>

                                                {canEdit && (
                                                    <button
                                                        onClick={(e) => handleDelete(template._id, e)}
                                                        className="text-gray-400 hover:text-red-500 p-1"
                                                        title="Delete"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        <h3 className="font-semibold text-lg text-gray-900 mb-1 truncate" title={template.name}>
                                            {template.name}
                                        </h3>
                                        <p className="text-sm text-gray-500 mb-4 truncate" title={template.subject}>
                                            Subject: {template.subject}
                                        </p>
                                        <div className="text-xs text-gray-400">
                                            Last updated: {new Date(template.lastUpdatedAt).toLocaleDateString()}
                                        </div>
                                    </div>

                                    <div className="mt-6 pt-4 border-t border-gray-100 flex gap-2">
                                        {/* Share / Unshare toggle — only for owner or admin */}
                                        {canEdit && (
                                            <button
                                                onClick={(e) =>
                                                    handleToggleVisibility(
                                                        template._id,
                                                        template.visibility,
                                                        e
                                                    )
                                                }
                                                disabled={isToggling}
                                                title={isShared ? "Make private" : "Share with everyone"}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors disabled:opacity-50 ${
                                                    isShared
                                                        ? "border-green-200 text-green-700 hover:bg-green-50"
                                                        : "border-gray-200 text-gray-500 hover:bg-gray-50"
                                                }`}
                                            >
                                                {isShared ? (
                                                    <>
                                                        <Globe size={13} />
                                                        {isToggling ? "Saving..." : "Shared"}
                                                    </>
                                                ) : (
                                                    <>
                                                        <Lock size={13} />
                                                        {isToggling ? "Saving..." : "Private"}
                                                    </>
                                                )}
                                            </button>
                                        )}

                                        {canEdit ? (
                                            <Link href={`/templates/email/${template._id}`} className="flex-1">
                                                <Button variant="secondary" className="w-full gap-2">
                                                    <Edit2 size={14} />
                                                    Edit Template
                                                </Button>
                                            </Link>
                                        ) : (
                                            <div className="flex-1 flex items-center justify-center text-xs text-gray-400 italic">
                                                Read-only
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
