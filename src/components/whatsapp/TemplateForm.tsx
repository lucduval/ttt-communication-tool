"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Button } from "@/components/ui";
import { Loader2 } from "lucide-react";
import type { Doc, Id } from "@/../convex/_generated/dataModel";

const CATEGORIES = ["marketing", "utility", "authentication"] as const;
const LANGUAGES = ["en", "en_US", "en_GB", "af", "zu", "xh"] as const;
const STATUSES = ["pending", "approved", "rejected"] as const;
const HEADER_TYPES = ["none", "text", "image", "document", "video"] as const;

interface TemplateFormProps {
    initialData?: Doc<"whatsappTemplates"> | null;
    onSuccess: (templateId?: Id<"whatsappTemplates">) => void;
    onCancel: () => void;
}

export function TemplateForm({ initialData, onSuccess, onCancel }: TemplateFormProps) {
    const createTemplate = useMutation(api.whatsappTemplates.create);
    const updateTemplate = useMutation(api.whatsappTemplates.update);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formData, setFormData] = useState({
        name: "",
        metaTemplateId: "",
        category: "marketing" as typeof CATEGORIES[number],
        status: "approved" as typeof STATUSES[number],
        body: "",
        language: "en" as typeof LANGUAGES[number],
        variableMappings: {} as Record<string, string>,
        headerType: "none" as typeof HEADER_TYPES[number],
        headerText: "",
        headerUrl: "",
    });

    const DYNAMICS_FIELDS = [
        { label: "Full Name", value: "fullname" },
        { label: "First Name", value: "firstname" },
        { label: "Last Name", value: "lastname" },
        { label: "Phone Number", value: "mobilephone" },
        { label: "Email Address", value: "emailaddress1" },
        { label: "Company Name", value: "parentcustomerid" },
        { label: "Account Number", value: "accountnumber" },
        { label: "Address", value: "address1_composite" },
        { label: "City", value: "address1_city" },
    ] as const;

    useEffect(() => {
        if (initialData) {
            let parsedMappings = {};
            try {
                if (initialData.variableMappings) {
                    parsedMappings = JSON.parse(initialData.variableMappings);
                }
            } catch (e) {
                console.error("Failed to parse variable mappings", e);
            }

            setFormData({
                name: initialData.name,
                metaTemplateId: initialData.metaTemplateId,
                category: initialData.category as typeof CATEGORIES[number],
                status: initialData.status as typeof STATUSES[number],
                body: initialData.body,
                language: initialData.language as typeof LANGUAGES[number],
                variableMappings: parsedMappings,
                headerType: (initialData.headerType as typeof HEADER_TYPES[number]) || "none",
                headerText: initialData.headerText || "",
                headerUrl: initialData.headerUrl || "",
            });
        }
    }, [initialData]);

    // Extract variables from body text
    const extractVariables = (body: string): string[] => {
        const matches = body.match(/\{\{([^}]+)\}\}/g);
        if (!matches) return [];
        return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
    };

    const handleMappingChange = (variable: string, field: string) => {
        setFormData(prev => ({
            ...prev,
            variableMappings: {
                ...prev.variableMappings,
                [variable]: field
            }
        }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            const variables = extractVariables(formData.body);
            // clean up mappings for variables that no longer exist
            const relevantMappings: Record<string, string> = {};
            variables.forEach(v => {
                if (formData.variableMappings[v]) {
                    relevantMappings[v] = formData.variableMappings[v];
                }
            });

            const submissionData = {
                ...formData,
                variables,
                variableMappings: JSON.stringify(relevantMappings),
                headerType: formData.headerType,
                headerText: formData.headerType === "text" ? formData.headerText : undefined,
                headerUrl: ["image", "document", "video"].includes(formData.headerType) ? formData.headerUrl : undefined,
            };

            let templateId: Id<"whatsappTemplates">;

            if (initialData) {
                await updateTemplate({
                    id: initialData._id,
                    ...submissionData,
                });
                templateId = initialData._id;
            } else {
                templateId = await createTemplate(submissionData);
            }
            onSuccess(templateId);
        } catch (err) {
            console.error("Failed to save template:", err);
            // ideally show toast error here
        } finally {
            setIsSubmitting(false);
        }
    };

    const variables = extractVariables(formData.body);

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Template Name
                    </label>
                    <input
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) =>
                            setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder="e.g. Statement Alert"
                        className="w-full px-3 py-2 border border-gray-200 rounded-md"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Meta Template ID
                    </label>
                    <input
                        type="text"
                        required
                        value={formData.metaTemplateId}
                        onChange={(e) =>
                            setFormData({ ...formData, metaTemplateId: e.target.value })
                        }
                        placeholder="e.g. statement_alert_v1"
                        className="w-full px-3 py-2 border border-gray-200 rounded-md"
                    />
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Category
                    </label>
                    <select
                        value={formData.category}
                        onChange={(e) =>
                            setFormData({
                                ...formData,
                                category: e.target.value as typeof CATEGORIES[number],
                            })
                        }
                        className="w-full px-3 py-2 border border-gray-200 rounded-md"
                    >
                        {CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                                {cat.charAt(0).toUpperCase() + cat.slice(1)}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Status
                    </label>
                    <select
                        value={formData.status}
                        onChange={(e) =>
                            setFormData({
                                ...formData,
                                status: e.target.value as typeof STATUSES[number],
                            })
                        }
                        className="w-full px-3 py-2 border border-gray-200 rounded-md"
                    >
                        {STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {status.charAt(0).toUpperCase() + status.slice(1)}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Language
                    </label>
                    <select
                        value={formData.language}
                        onChange={(e) =>
                            setFormData({
                                ...formData,
                                language: e.target.value as typeof LANGUAGES[number],
                            })
                        }
                        className="w-full px-3 py-2 border border-gray-200 rounded-md"
                    >
                        {LANGUAGES.map((lang) => (
                            <option key={lang} value={lang}>
                                {lang}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Header Configuration */}
            <div className="p-4 bg-amber-50 rounded-lg border border-amber-100">
                <h4 className="text-sm font-semibold text-amber-900 mb-3">
                    Template Header
                </h4>
                <p className="text-xs text-amber-700 mb-4">
                    If your Meta template has a header (image, text, video, or document), configure it here.
                </p>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Header Type
                        </label>
                        <select
                            value={formData.headerType}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    headerType: e.target.value as typeof HEADER_TYPES[number],
                                })
                            }
                            className="w-full px-3 py-2 border border-gray-200 rounded-md"
                        >
                            {HEADER_TYPES.map((type) => (
                                <option key={type} value={type}>
                                    {type.charAt(0).toUpperCase() + type.slice(1)}
                                </option>
                            ))}
                        </select>
                    </div>
                    {formData.headerType === "text" && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Header Text
                            </label>
                            <input
                                type="text"
                                value={formData.headerText}
                                onChange={(e) =>
                                    setFormData({ ...formData, headerText: e.target.value })
                                }
                                placeholder="e.g. Account Statement"
                                className="w-full px-3 py-2 border border-gray-200 rounded-md"
                            />
                        </div>
                    )}
                    {["image", "document", "video"].includes(formData.headerType) && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Header URL
                            </label>
                            <input
                                type="url"
                                value={formData.headerUrl}
                                onChange={(e) =>
                                    setFormData({ ...formData, headerUrl: e.target.value })
                                }
                                placeholder="https://example.com/image.jpg"
                                className="w-full px-3 py-2 border border-gray-200 rounded-md"
                                required={["image", "document", "video"].includes(formData.headerType)}
                            />
                            <p className="text-xs text-gray-400 mt-1">
                                Must be a publicly accessible URL
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                    Message Body
                </label>
                <textarea
                    required
                    value={formData.body}
                    onChange={(e) =>
                        setFormData({ ...formData, body: e.target.value })
                    }
                    placeholder="Hello {{name}}, your statement for {{month}} is ready."
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-200 rounded-md font-mono text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">
                    Use {`{{variable}}`} syntax for dynamic values. They will be
                    auto-extracted.
                </p>
            </div>

            {variables.length > 0 && (
                <div className="p-4 bg-gray-50 rounded-lg border border-gray-100">
                    <h4 className="text-sm font-semibold text-gray-900 mb-3">
                        Map Template Variables
                    </h4>
                    <p className="text-xs text-gray-500 mb-4">
                        Map each template variable to a corresponding field in Dynamics 365.
                    </p>

                    <div className="space-y-3">
                        {variables.map((variable) => (
                            <div key={variable} className="flex items-center gap-3">
                                <div className="w-1/3 flex items-center justify-end">
                                    <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-mono font-medium">
                                        {`{{${variable}}}`}
                                    </span>
                                </div>
                                <div className="text-gray-400">→</div>
                                <div className="flex-1">
                                    <select
                                        value={formData.variableMappings[variable] || ""}
                                        onChange={(e) => handleMappingChange(variable, e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm"
                                        required
                                    >
                                        <option value="">Select Dynamics Field...</option>
                                        {DYNAMICS_FIELDS.map((field) => (
                                            <option key={field.value} value={field.value}>
                                                {field.label} ({field.value})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                    type="button"
                    variant="secondary"
                    onClick={onCancel}
                >
                    Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && (
                        <Loader2 size={16} className="animate-spin mr-2" />
                    )}
                    {initialData ? "Update Template" : "Add Template"}
                </Button>
            </div>
        </form>
    );
}
