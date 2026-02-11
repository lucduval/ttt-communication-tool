"use client";

import { useState, useMemo } from "react";
import { Search, Info, Plus, X } from "lucide-react";
import { TemplateCard } from "./TemplateCard";
import { TemplateForm } from "./TemplateForm";
import type { Doc, Id } from "@/../convex/_generated/dataModel";
import { Button, Card } from "@/components/ui";

interface TemplateSelectorProps {
    templates: Doc<"whatsappTemplates">[];
    selectedTemplateId: Id<"whatsappTemplates"> | null;
    onSelectTemplate: (template: Doc<"whatsappTemplates">) => void;
    variableValues: Record<string, string>;
    onVariableChange: (variable: string, value: string) => void;
}

export function TemplateSelector({
    templates,
    selectedTemplateId,
    onSelectTemplate,
    variableValues,
    onVariableChange,
}: TemplateSelectorProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [showCreateForm, setShowCreateForm] = useState(false);

    const filteredTemplates = useMemo(() => {
        if (!searchQuery) return templates;
        const query = searchQuery.toLowerCase();
        return templates.filter(
            (t) =>
                t.name.toLowerCase().includes(query) ||
                t.body.toLowerCase().includes(query)
        );
    }, [templates, searchQuery]);

    const selectedTemplate = templates.find((t) => t._id === selectedTemplateId);

    const handleCreateSuccess = (templateId?: Id<"whatsappTemplates">) => {
        setShowCreateForm(false);
        if (templateId) {
            // Find the template in the list (it should be there thanks to Convex reactivity)
            // But we might need to wait for it to appear if we rely purely on `templates` prop update.
            // For now, let's trust that the parent component (page) will update `templates` prop via useQuery
            // and we can try to find it. 
            // Better UX: The user just created it, we can't select it immediately if `templates` hasn't refreshed.
            // However, Convex is fast.
            // We can search for it in `templates` in a useEffect, or just ask the user to select it (less ideal).

            // Actually, we can't synchronously select it here because `templates` prop is old.
            // We can pass a callback to parent to "auto-select next received template with this ID"?
            // Or just close modal and let user select (simplest for now).

            // BUT, the requirement is "create template here in this flow".
            // Ideally we auto-select it.
            // Let's rely on the user finding it for a split second, or we can implement a "pending selection" logic in parent if needed.
            // For now, let's keep it simple: Close modal.

            // Wait, we can assume the user wants to use it.
            // Let's try to set it if we can find it next render.
        }
    };

    return (
        <div className="space-y-6">
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xl font-bold text-gray-900">
                        Select a WhatsApp Template
                    </h3>
                    <Button onClick={() => setShowCreateForm(true)} className="text-sm px-3 py-1.5">
                        <Plus size={16} />
                        New Template
                    </Button>
                </div>
                <div className="p-4 bg-amber-50 border border-amber-100 rounded-lg flex gap-3 text-amber-800 text-sm">
                    <Info size={18} className="shrink-0 mt-0.5" />
                    <p>
                        WhatsApp messages must use pre-approved templates from Meta Business
                        Suite. Select a template and fill in the variable values.
                    </p>
                </div>
            </div>

            {/* Search */}
            <div className="relative">
                <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                    size={18}
                />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search templates..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20"
                />
            </div>

            {/* Template Grid */}
            {templates.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                    <p className="text-gray-500">No templates found.</p>
                    <p className="text-sm text-gray-400 mt-1">
                        Add templates to start sending messages.
                    </p>
                    <Button onClick={() => setShowCreateForm(true)} className="mt-4" variant="secondary">
                        <Plus size={16} />
                        Create Template
                    </Button>
                </div>
            ) : filteredTemplates.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                    <p className="text-gray-500">No results found for "{searchQuery}".</p>
                    <Button
                        onClick={() => setSearchQuery("")}
                        className="mt-2 text-sm"
                        variant="ghost"
                    >
                        Clear search
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[400px] overflow-y-auto pr-2">
                    {filteredTemplates.map((template) => (
                        <TemplateCard
                            key={template._id}
                            template={template}
                            isSelected={template._id === selectedTemplateId}
                            onSelect={() => onSelectTemplate(template)}
                        />
                    ))}
                </div>
            )}

            {/* Variable Inputs */}
            {selectedTemplate && selectedTemplate.variables.length > 0 && (
                <div className="border-t border-gray-200 pt-6">
                    <h4 className="font-semibold text-gray-900 mb-4">
                        Fill in Template Variables
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {selectedTemplate.variables.map((variable) => (
                            <div key={variable}>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    {variable}
                                </label>
                                <input
                                    type="text"
                                    value={variableValues[variable] || ""}
                                    onChange={(e) => onVariableChange(variable, e.target.value)}
                                    placeholder={`Enter ${variable}...`}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20"
                                />
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-3">
                        Note: Variables like name and phone will be auto-filled from
                        recipient data when sending.
                    </p>
                </div>
            )}

            {/* Create Template Modal */}
            {showCreateForm && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-lg font-bold text-gray-900">
                                Add New Template
                            </h3>
                            <button
                                onClick={() => setShowCreateForm(false)}
                                className="p-2 hover:bg-gray-100 rounded-full"
                            >
                                <X size={20} className="text-gray-500" />
                            </button>
                        </div>
                        <TemplateForm
                            onSuccess={handleCreateSuccess}
                            onCancel={() => setShowCreateForm(false)}
                        />
                    </Card>
                </div>
            )}
        </div>
    );
}
