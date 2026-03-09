"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { EmailComposer } from "@/components/email/EmailComposer";
import { Button } from "@/components/ui/Button";
import { ChevronLeft, Globe, Lock, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { Id } from "../../../../../convex/_generated/dataModel";

interface EditTemplatePageProps {
    params: Promise<{
        id: string;
    }>;
}

export default function EditTemplatePage({ params }: EditTemplatePageProps) {
    const { id } = use(params);
    const router = useRouter();
    const isNew = id === "new";
    const templateId = isNew ? undefined : (id as Id<"emailTemplates">);

    const template = useQuery(api.emailTemplates.getById, templateId ? { id: templateId } : "skip");
    const currentUser = useQuery(api.users.getCurrentUser);
    const createTemplate = useMutation(api.emailTemplates.create);
    const updateTemplate = useMutation(api.emailTemplates.update);

    const [name, setName] = useState("");
    const [subject, setSubject] = useState("");
    const [htmlContent, setHtmlContent] = useState("");
    const [fontSize, setFontSize] = useState("18px");
    const [visibility, setVisibility] = useState<"private" | "shared">("private");
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (template) {
            setName(template.name);
            setSubject(template.subject);
            setHtmlContent(template.htmlContent);
            if (template.fontSize) setFontSize(template.fontSize);
            setVisibility(template.visibility ?? "shared");
        }
    }, [template]);

    const isAdmin = currentUser?.role === "admin";
    const isOwner = template ? template.createdBy === currentUser?._id : true;
    const canEdit = isNew || isAdmin || isOwner;

    const handleSave = async () => {
        if (!name.trim()) {
            alert("Please enter a template name");
            return;
        }
        if (!subject.trim()) {
            alert("Please enter a subject");
            return;
        }

        setIsSubmitting(true);
        try {
            if (isNew) {
                await createTemplate({
                    name,
                    subject,
                    htmlContent,
                    fontSize,
                    visibility,
                });
                router.push("/templates/email");
            } else {
                if (templateId) {
                    await updateTemplate({
                        id: templateId,
                        name,
                        subject,
                        htmlContent,
                        fontSize,
                        visibility,
                    });
                    router.push("/templates/email");
                }
            }
        } catch (error) {
            console.error(error);
            alert("Failed to save template");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isNew && (template === undefined || currentUser === undefined)) {
        return <div className="p-8 text-center">Loading template...</div>;
    }

    if (!isNew && template === null) {
        return <div className="p-8 text-center">Template not found</div>;
    }

    return (
        <div className="flex flex-col h-screen">
            {/* Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Link href="/templates/email" className="text-gray-500 hover:text-gray-700">
                        <ChevronLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-xl font-bold text-gray-900">
                            {isNew ? "Create New Template" : "Edit Template"}
                        </h1>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Template Name e.g. Monthly Newsletter"
                            className="bg-transparent text-sm text-gray-600 outline-none w-full max-w-sm mt-1 focus:ring-1 focus:ring-blue-200 rounded px-1"
                        />
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {/* Visibility toggle */}
                    {canEdit && (
                        <button
                            type="button"
                            onClick={() =>
                                setVisibility((v) => (v === "shared" ? "private" : "shared"))
                            }
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                                visibility === "shared"
                                    ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                                    : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                            }`}
                            title={
                                visibility === "shared"
                                    ? "Visible to everyone — click to make private"
                                    : "Only visible to you — click to share"
                            }
                        >
                            {visibility === "shared" ? (
                                <>
                                    <Globe size={15} />
                                    Shared
                                </>
                            ) : (
                                <>
                                    <Lock size={15} />
                                    Private
                                </>
                            )}
                        </button>
                    )}

                    <Link href="/templates/email">
                        <Button variant="ghost">Cancel</Button>
                    </Link>
                    {canEdit && (
                        <Button onClick={handleSave} disabled={isSubmitting} className="gap-2">
                            <Save size={18} />
                            {isSubmitting ? "Saving..." : "Save Template"}
                        </Button>
                    )}
                </div>
            </div>

            {/* Editor Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                <div className="max-w-5xl mx-auto bg-white rounded-lg shadow-sm border border-gray-200 p-6 min-h-[calc(100vh-140px)]">
                    <EmailComposer
                        subject={subject}
                        onSubjectChange={setSubject}
                        htmlContent={htmlContent}
                        onContentChange={setHtmlContent}
                        fontSize={fontSize}
                        onFontSizeChange={setFontSize}
                        onImageUpload={async () => {
                            return { url: "", contentId: "" };
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
