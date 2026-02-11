"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Header } from "@/components/layout";
import { Button, Card, Badge } from "@/components/ui";
import {
    Plus,
    Pencil,
    Trash2,
    X,
    MessageSquare,
    Info,
    Loader2,
} from "lucide-react";
import type { Doc, Id } from "@/../convex/_generated/dataModel";
import { TemplateForm } from "@/components/whatsapp";

const CATEGORIES = ["marketing", "utility", "authentication"] as const;

export default function WhatsAppTemplatesPage() {
    const templates = useQuery(api.whatsappTemplates.list, {});
    const deleteTemplate = useMutation(api.whatsappTemplates.remove);

    const [showForm, setShowForm] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<Doc<"whatsappTemplates"> | null>(null);

    const handleCloseForm = () => {
        setEditingTemplate(null);
        setShowForm(false);
    };

    const openEditForm = (template: Doc<"whatsappTemplates">) => {
        setEditingTemplate(template);
        setShowForm(true);
    };

    const handleSuccess = () => {
        handleCloseForm();
    };

    const handleDelete = async (id: Id<"whatsappTemplates">) => {
        if (!confirm("Are you sure you want to delete this template?")) return;
        try {
            await deleteTemplate({ id });
        } catch (err) {
            console.error("Failed to delete template:", err);
        }
    };

    const categoryColors: Record<string, string> = {
        marketing: "bg-purple-100 text-purple-700",
        utility: "bg-blue-100 text-blue-700",
        authentication: "bg-amber-100 text-amber-700",
    };

    return (
        <>
            <Header title="WhatsApp Templates" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    {/* Info Card */}
                    <Card className="border-blue-200 bg-blue-50">
                        <div className="flex items-start gap-3">
                            <Info className="text-blue-600 shrink-0" size={20} />
                            <div>
                                <h4 className="font-semibold text-blue-800">
                                    Template Management
                                </h4>
                                <p className="text-sm text-blue-700 mt-1">
                                    Templates must be created and approved in Meta Business Suite first.
                                    Add them here to use in your WhatsApp campaigns. The template body
                                    should match exactly what&apos;s in Meta.
                                </p>
                            </div>
                        </div>
                    </Card>

                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">
                                Message Templates
                            </h2>
                            <p className="text-sm text-gray-500">
                                {templates?.length || 0} templates available
                            </p>
                        </div>
                        <Button onClick={() => setShowForm(true)}>
                            <Plus size={18} />
                            Add Template
                        </Button>
                    </div>

                    {/* Template Form Modal */}
                    {showForm && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                            <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                                <div className="flex items-center justify-between mb-6">
                                    <h3 className="text-lg font-bold text-gray-900">
                                        {editingTemplate ? "Edit Template" : "Add New Template"}
                                    </h3>
                                    <button
                                        onClick={handleCloseForm}
                                        className="p-2 hover:bg-gray-100 rounded-full"
                                    >
                                        <X size={20} className="text-gray-500" />
                                    </button>
                                </div>
                                <TemplateForm
                                    initialData={editingTemplate}
                                    onSuccess={handleSuccess}
                                    onCancel={handleCloseForm}
                                />
                            </Card>
                        </div>
                    )}

                    {/* Templates Grid */}
                    {templates === undefined ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 size={32} className="animate-spin text-gray-400" />
                        </div>
                    ) : templates.length === 0 ? (
                        <Card className="text-center py-12">
                            <MessageSquare
                                size={48}
                                className="mx-auto text-gray-300 mb-4"
                            />
                            <h3 className="text-lg font-semibold text-gray-700 mb-2">
                                No templates yet
                            </h3>
                            <p className="text-sm text-gray-500 mb-4">
                                Add your first WhatsApp template to start sending messages.
                            </p>
                            <Button onClick={() => setShowForm(true)}>
                                <Plus size={18} />
                                Add Template
                            </Button>
                        </Card>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {templates.map((template) => (
                                <Card key={template._id} className="flex flex-col">
                                    <div className="flex items-start justify-between mb-3">
                                        <div>
                                            <h4 className="font-bold text-gray-900">
                                                {template.name}
                                            </h4>
                                            <p className="text-xs text-gray-400 font-mono">
                                                {template.metaTemplateId}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`px-2 py-0.5 rounded text-xs font-medium ${categoryColors[template.category] ||
                                                    "bg-gray-100 text-gray-600"
                                                    }`}
                                            >
                                                {template.category}
                                            </span>
                                        </div>
                                    </div>

                                    <p className="text-sm text-gray-600 flex-1 mb-3 line-clamp-3">
                                        {template.body}
                                    </p>

                                    {template.variables.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mb-3">
                                            {template.variables.map((v) => (
                                                <span
                                                    key={v}
                                                    className="px-1.5 py-0.5 bg-green-50 text-green-600 rounded text-xs"
                                                >
                                                    {v}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                                        <div className="flex items-center gap-2">
                                            <Badge
                                                status={
                                                    template.status === "approved"
                                                        ? "success"
                                                        : template.status === "rejected"
                                                            ? "error"
                                                            : "warning"
                                                }
                                            >
                                                {template.status}
                                            </Badge>
                                            <span className="text-xs text-gray-400">
                                                {template.language}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => openEditForm(template)}
                                                className="p-1.5 hover:bg-gray-100 rounded"
                                            >
                                                <Pencil size={16} className="text-gray-500" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(template._id)}
                                                className="p-1.5 hover:bg-red-50 rounded"
                                            >
                                                <Trash2 size={16} className="text-red-500" />
                                            </button>
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </>
    );
}
