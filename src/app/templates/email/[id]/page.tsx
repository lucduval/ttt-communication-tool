"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { EmailComposer } from "@/components/email/EmailComposer";
import { Button } from "@/components/ui/Button";
import { ChevronLeft, Save } from "lucide-react";
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
    const createTemplate = useMutation(api.emailTemplates.create);
    const updateTemplate = useMutation(api.emailTemplates.update);

    const [name, setName] = useState("");
    const [subject, setSubject] = useState("");
    const [htmlContent, setHtmlContent] = useState("");
    const [fontSize, setFontSize] = useState("18px");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Load template data
    useEffect(() => {
        if (template) {
            setName(template.name);
            setSubject(template.subject);
            setHtmlContent(template.htmlContent);
            if (template.fontSize) setFontSize(template.fontSize);
        }
    }, [template]);

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
                });
                alert("Template created");
                router.push("/templates/email");
            } else {
                if (templateId) {
                    await updateTemplate({
                        id: templateId,
                        name,
                        subject,
                        htmlContent,
                        fontSize,
                    });
                    // toast.success("Template updated");
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

    if (!isNew && template === undefined) {
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
                <div className="flex gap-3">
                    <Link href="/templates/email">
                        <Button variant="ghost">Cancel</Button>
                    </Link>
                    <Button onClick={handleSave} disabled={isSubmitting} className="gap-2">
                        <Save size={18} />
                        {isSubmitting ? "Saving..." : "Save Template"}
                    </Button>
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
                        // We can reuse image upload functionality if needed, or implement a simple one
                        onImageUpload={async (file) => {
                            // Ideally, this should upload to storage and return URL
                            // For now, we rely on base64 insertion handled by EmailComposer fallbacks
                            // or if we have storage logic from campaigns we can reuse it.
                            // Since EmailComposer handles inline base64 as fallback, we can skip explicit upload for now
                            // or implement a simple upload mutation.
                            return { url: "", contentId: "" };
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
