"use client";

import { useState, useEffect, useRef } from "react";
import { useMutation, useConvex } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Button } from "@/components/ui";
import { Globe, Lock, Loader2, Upload, X } from "lucide-react";
import type { Doc, Id } from "@/../convex/_generated/dataModel";

const CATEGORIES = ["marketing", "utility", "authentication"] as const;
const LANGUAGES = ["en", "en_US", "en_GB", "af", "zu", "xh"] as const;
const STATUSES = ["pending", "approved", "rejected"] as const;
const HEADER_TYPES = ["none", "text", "image", "document", "video"] as const;
const BUTTON_TYPES = ["none", "url"] as const;

/**
 * Per-category file constraints aligned with Meta's WhatsApp Cloud API limits.
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 * Validated client-side so we reject before uploading bytes that Meta would
 * reject at send time.
 */
const HEADER_FILE_CONSTRAINTS: Record<
    "video" | "image" | "document",
    { mimeTypes: string[]; maxBytes: number; accept: string; label: string }
> = {
    video: {
        mimeTypes: ["video/mp4", "video/3gp", "video/3gpp"],
        maxBytes: 16 * 1024 * 1024,
        accept: ".mp4,.3gp,video/mp4,video/3gp,video/3gpp",
        label: "MP4 or 3GP · max 16 MB · H.264 + AAC",
    },
    image: {
        mimeTypes: ["image/jpeg", "image/png"],
        maxBytes: 5 * 1024 * 1024,
        accept: ".jpg,.jpeg,.png,image/jpeg,image/png",
        label: "JPG or PNG · max 5 MB",
    },
    document: {
        mimeTypes: [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/plain",
        ],
        accept: ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt",
        maxBytes: 100 * 1024 * 1024,
        label: "PDF / Office / TXT · max 100 MB",
    },
};

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

interface TemplateFormProps {
    initialData?: Doc<"whatsappTemplates"> | null;
    onSuccess: (templateId?: Id<"whatsappTemplates">) => void;
    onCancel: () => void;
}

export function TemplateForm({ initialData, onSuccess, onCancel }: TemplateFormProps) {
    const createTemplate = useMutation(api.whatsappTemplates.create);
    const updateTemplate = useMutation(api.whatsappTemplates.update);
    const generateUploadUrl = useMutation(api.files.generateUploadUrl);
    const convex = useConvex();

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isUploadingHeader, setIsUploadingHeader] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
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
        buttonType: "none" as typeof BUTTON_TYPES[number],
        buttonText: "",
        buttonUrl: "",
        buttonUrlVariable: "",
        button2Type: "none" as typeof BUTTON_TYPES[number],
        button2Text: "",
        button2Url: "",
        button2UrlVariable: "",
        visibility: "shared" as "private" | "shared",
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
        { label: "Referral Code", value: "riivo_referralcode" },
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
                buttonType: (initialData.buttonType as typeof BUTTON_TYPES[number]) || "none",
                buttonText: initialData.buttonText || "",
                buttonUrl: initialData.buttonUrl || "",
                buttonUrlVariable: initialData.buttonUrlVariable || "",
                button2Type: (initialData.button2Type as typeof BUTTON_TYPES[number]) || "none",
                button2Text: initialData.button2Text || "",
                button2Url: initialData.button2Url || "",
                button2UrlVariable: initialData.button2UrlVariable || "",
                visibility: (initialData.visibility as "private" | "shared") ?? "shared",
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

    const handleHeaderFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Reset input so picking the same file again retriggers onChange.
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!file) return;

        const headerType = formData.headerType;
        if (headerType !== "video" && headerType !== "image" && headerType !== "document") return;

        const constraints = HEADER_FILE_CONSTRAINTS[headerType];
        setUploadError(null);

        // Some browsers leave file.type empty for less common extensions (e.g. 3gp);
        // fall back to the extension check via the `accept` attribute on the input.
        if (file.type && !constraints.mimeTypes.includes(file.type)) {
            setUploadError(
                `File type "${file.type}" not allowed for a ${headerType} header. Accepts: ${constraints.label}`
            );
            return;
        }
        if (file.size > constraints.maxBytes) {
            setUploadError(
                `File is ${formatBytes(file.size)} — exceeds Meta limit of ${formatBytes(constraints.maxBytes)} for ${headerType} headers.`
            );
            return;
        }

        setIsUploadingHeader(true);
        try {
            const uploadUrl = await generateUploadUrl();
            const uploadResp = await fetch(uploadUrl, {
                method: "POST",
                headers: { "Content-Type": file.type || "application/octet-stream" },
                body: file,
            });
            if (!uploadResp.ok) {
                throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
            }
            const { storageId } = (await uploadResp.json()) as { storageId: Id<"_storage"> };
            const publicUrl = await convex.query(api.files.getDownloadUrl, { storageId });
            if (!publicUrl) throw new Error("Convex returned no download URL");
            setFormData((prev) => ({ ...prev, headerUrl: publicUrl }));
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : "Upload failed");
        } finally {
            setIsUploadingHeader(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Block submission until any in-flight upload completes — otherwise we'd
        // save an empty headerUrl while the file is still being uploaded.
        if (isUploadingHeader) return;

        const isMediaHeader =
            formData.headerType === "image" ||
            formData.headerType === "document" ||
            formData.headerType === "video";
        if (isMediaHeader && !formData.headerUrl) {
            setUploadError(`Upload a ${formData.headerType} or paste a public URL.`);
            return;
        }

        // Block submission of a dynamic URL button without a Dynamics field
        // selected for {{1}} — at send time we'd send an empty suffix, which
        // Meta would render as a broken URL.
        const isDynamicButton =
            formData.buttonType === "url" && formData.buttonUrl.includes("{{1}}");
        if (isDynamicButton && !formData.buttonUrlVariable) {
            setUploadError("Pick a Dynamics field to substitute for `{{1}}` in the button URL.");
            return;
        }
        const isDynamicButton2 =
            formData.button2Type === "url" && formData.button2Url.includes("{{1}}");
        if (isDynamicButton2 && !formData.button2UrlVariable) {
            setUploadError("Pick a Dynamics field to substitute for `{{1}}` in the 2nd button URL.");
            return;
        }
        // Meta button positions are fixed by the approved template, so a 2nd
        // URL button only makes sense when the 1st slot is also a URL button.
        if (formData.button2Type === "url" && formData.buttonType !== "url") {
            setUploadError("Configure Button #1 as a URL before adding Button #2.");
            return;
        }

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
                buttonType: formData.buttonType,
                buttonText: formData.buttonType === "url" ? formData.buttonText : undefined,
                buttonUrl: formData.buttonType === "url" ? formData.buttonUrl : undefined,
                buttonUrlVariable: isDynamicButton ? formData.buttonUrlVariable : undefined,
                button2Type: formData.button2Type,
                button2Text: formData.button2Type === "url" ? formData.button2Text : undefined,
                button2Url: formData.button2Type === "url" ? formData.button2Url : undefined,
                button2UrlVariable: isDynamicButton2 ? formData.button2UrlVariable : undefined,
                visibility: formData.visibility,
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
                            onChange={(e) => {
                                const next = e.target.value as typeof HEADER_TYPES[number];
                                setUploadError(null);
                                setFormData((prev) => ({
                                    ...prev,
                                    headerType: next,
                                    // Clear the URL when switching categories so a previously
                                    // uploaded video URL doesn't accidentally get reused for
                                    // an image header (and vice versa).
                                    headerUrl: prev.headerType === next ? prev.headerUrl : "",
                                }));
                            }}
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
                    {(formData.headerType === "image" ||
                        formData.headerType === "document" ||
                        formData.headerType === "video") && (
                        <div className="col-span-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Header File
                            </label>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={HEADER_FILE_CONSTRAINTS[formData.headerType].accept}
                                onChange={handleHeaderFileChange}
                                className="hidden"
                                id="header-file-input"
                            />
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isUploadingHeader}
                                    className="flex items-center gap-2"
                                >
                                    {isUploadingHeader ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            Uploading…
                                        </>
                                    ) : (
                                        <>
                                            <Upload size={14} />
                                            {formData.headerUrl ? "Replace file" : "Choose file"}
                                        </>
                                    )}
                                </Button>
                                {formData.headerUrl && !isUploadingHeader && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setFormData((prev) => ({ ...prev, headerUrl: "" }));
                                            setUploadError(null);
                                        }}
                                        className="text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
                                    >
                                        <X size={12} />
                                        Remove
                                    </button>
                                )}
                            </div>
                            <p className="text-xs text-gray-400 mt-1">
                                {HEADER_FILE_CONSTRAINTS[formData.headerType].label}
                            </p>
                            {uploadError && (
                                <p className="text-xs text-red-600 mt-1">{uploadError}</p>
                            )}
                            {formData.headerUrl && !isUploadingHeader && (
                                <div className="mt-2">
                                    {formData.headerType === "video" && (
                                        <video
                                            src={formData.headerUrl}
                                            controls
                                            className="max-h-32 rounded border border-gray-200"
                                        />
                                    )}
                                    {formData.headerType === "image" && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={formData.headerUrl}
                                            alt="Header preview"
                                            className="max-h-32 rounded border border-gray-200"
                                        />
                                    )}
                                    {formData.headerType === "document" && (
                                        <a
                                            href={formData.headerUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-xs text-blue-600 underline break-all"
                                        >
                                            {formData.headerUrl.split("/").pop() || "View document"}
                                        </a>
                                    )}
                                </div>
                            )}
                            <details className="mt-2">
                                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                                    Or paste a public URL
                                </summary>
                                <input
                                    type="url"
                                    value={formData.headerUrl}
                                    onChange={(e) =>
                                        setFormData({ ...formData, headerUrl: e.target.value })
                                    }
                                    placeholder="https://example.com/video.mp4"
                                    className="w-full px-3 py-2 mt-1 border border-gray-200 rounded-md text-sm"
                                />
                            </details>
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
                    rows={6}
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

            {/* Template Button #1 */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                <h4 className="text-sm font-semibold text-blue-900 mb-3">
                    Template Button #1
                </h4>
                <p className="text-xs text-blue-700 mb-4">
                    If your Meta template has a call-to-action URL button, configure it here. Use{" "}
                    <span className="font-mono">{`{{1}}`}</span> in the URL where Meta should substitute a per-recipient value (dynamic link); leave it out for a static link.
                </p>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Button Type
                        </label>
                        <select
                            value={formData.buttonType}
                            onChange={(e) => {
                                const next = e.target.value as typeof BUTTON_TYPES[number];
                                setFormData((prev) => ({
                                    ...prev,
                                    buttonType: next,
                                    // Clear button fields when switching back to "none"
                                    ...(next === "none"
                                        ? { buttonText: "", buttonUrl: "", buttonUrlVariable: "" }
                                        : {}),
                                }));
                            }}
                            className="w-full px-3 py-2 border border-gray-200 rounded-md"
                        >
                            {BUTTON_TYPES.map((type) => (
                                <option key={type} value={type}>
                                    {type === "none" ? "None" : "URL"}
                                </option>
                            ))}
                        </select>
                    </div>
                    {formData.buttonType === "url" && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Button Label
                            </label>
                            <input
                                type="text"
                                value={formData.buttonText}
                                onChange={(e) =>
                                    setFormData({ ...formData, buttonText: e.target.value })
                                }
                                placeholder="e.g. Share with a friend"
                                className="w-full px-3 py-2 border border-gray-200 rounded-md"
                            />
                            <p className="text-xs text-gray-400 mt-1">
                                Must match the label approved in Meta.
                            </p>
                        </div>
                    )}
                </div>
                {formData.buttonType === "url" && (
                    <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Button URL
                        </label>
                        <input
                            type="text"
                            value={formData.buttonUrl}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    buttonUrl: e.target.value,
                                    // Reset variable picker when URL drops the {{1}} placeholder
                                    buttonUrlVariable: e.target.value.includes("{{1}}")
                                        ? formData.buttonUrlVariable
                                        : "",
                                })
                            }
                            placeholder="https://riivo.io/refer?code={{1}}"
                            className="w-full px-3 py-2 border border-gray-200 rounded-md font-mono text-sm"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                            Must match the URL approved in Meta. Include{" "}
                            <span className="font-mono">{`{{1}}`}</span> for a dynamic suffix.
                        </p>
                        {formData.buttonUrl.includes("{{1}}") && (
                            <div className="mt-3 flex items-center gap-3">
                                <div className="w-1/3 flex items-center justify-end">
                                    <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-mono font-medium">
                                        {`{{1}}`}
                                    </span>
                                </div>
                                <div className="text-gray-400">→</div>
                                <div className="flex-1">
                                    <select
                                        value={formData.buttonUrlVariable}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                buttonUrlVariable: e.target.value,
                                            })
                                        }
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
                        )}
                    </div>
                )}
            </div>

            {/* Template Button #2 — Meta allows up to 2 URL buttons per
                template. Only meaningful when Button #1 is also a URL. */}
            {formData.buttonType === "url" && (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                    <h4 className="text-sm font-semibold text-blue-900 mb-3">
                        Template Button #2 (optional)
                    </h4>
                    <p className="text-xs text-blue-700 mb-4">
                        Add a second URL button if your Meta template has one. Same rules apply — include{" "}
                        <span className="font-mono">{`{{1}}`}</span> for a dynamic link.
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Button Type
                            </label>
                            <select
                                value={formData.button2Type}
                                onChange={(e) => {
                                    const next = e.target.value as typeof BUTTON_TYPES[number];
                                    setFormData((prev) => ({
                                        ...prev,
                                        button2Type: next,
                                        ...(next === "none"
                                            ? { button2Text: "", button2Url: "", button2UrlVariable: "" }
                                            : {}),
                                    }));
                                }}
                                className="w-full px-3 py-2 border border-gray-200 rounded-md"
                            >
                                {BUTTON_TYPES.map((type) => (
                                    <option key={type} value={type}>
                                        {type === "none" ? "None" : "URL"}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {formData.button2Type === "url" && (
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Button Label
                                </label>
                                <input
                                    type="text"
                                    value={formData.button2Text}
                                    onChange={(e) =>
                                        setFormData({ ...formData, button2Text: e.target.value })
                                    }
                                    placeholder="e.g. Learn more"
                                    className="w-full px-3 py-2 border border-gray-200 rounded-md"
                                />
                                <p className="text-xs text-gray-400 mt-1">
                                    Must match the label approved in Meta.
                                </p>
                            </div>
                        )}
                    </div>
                    {formData.button2Type === "url" && (
                        <div className="mt-4">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Button URL
                            </label>
                            <input
                                type="text"
                                value={formData.button2Url}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        button2Url: e.target.value,
                                        button2UrlVariable: e.target.value.includes("{{1}}")
                                            ? formData.button2UrlVariable
                                            : "",
                                    })
                                }
                                placeholder="https://riivo.io/learn-more"
                                className="w-full px-3 py-2 border border-gray-200 rounded-md font-mono text-sm"
                            />
                            <p className="text-xs text-gray-400 mt-1">
                                Must match the URL approved in Meta. Include{" "}
                                <span className="font-mono">{`{{1}}`}</span> for a dynamic suffix.
                            </p>
                            {formData.button2Url.includes("{{1}}") && (
                                <div className="mt-3 flex items-center gap-3">
                                    <div className="w-1/3 flex items-center justify-end">
                                        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-mono font-medium">
                                            {`{{1}}`}
                                        </span>
                                    </div>
                                    <div className="text-gray-400">→</div>
                                    <div className="flex-1">
                                        <select
                                            value={formData.button2UrlVariable}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    button2UrlVariable: e.target.value,
                                                })
                                            }
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
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Visibility */}
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">Visibility</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                        {formData.visibility === "shared"
                            ? "Visible to all users"
                            : "Only visible to admins"}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() =>
                        setFormData((prev) => ({
                            ...prev,
                            visibility: prev.visibility === "shared" ? "private" : "shared",
                        }))
                    }
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
                        formData.visibility === "shared"
                            ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                            : "bg-gray-100 border-gray-200 text-gray-600 hover:bg-gray-200"
                    }`}
                >
                    {formData.visibility === "shared" ? (
                        <><Globe size={14} /> Shared</>
                    ) : (
                        <><Lock size={14} /> Private</>
                    )}
                </button>
            </div>

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
