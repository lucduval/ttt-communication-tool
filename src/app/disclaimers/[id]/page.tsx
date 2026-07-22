"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { ChevronLeft, Save, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { Id } from "../../../../convex/_generated/dataModel";

interface EditDisclaimerPageProps {
    params: Promise<{
        id: string;
    }>;
}

export default function EditDisclaimerPage({ params }: EditDisclaimerPageProps) {
    const { id } = use(params);
    const router = useRouter();
    const isNew = id === "new";
    const disclaimerId = isNew ? undefined : (id as Id<"disclaimers">);

    const disclaimer = useQuery(
        api.disclaimers.getById,
        disclaimerId ? { id: disclaimerId } : "skip"
    );
    const createDisclaimer = useMutation(api.disclaimers.create);
    const updateDisclaimer = useMutation(api.disclaimers.update);

    const [name, setName] = useState("");
    const [htmlContent, setHtmlContent] = useState("");
    const [isDefault, setIsDefault] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (disclaimer) {
            setName(disclaimer.name);
            setHtmlContent(disclaimer.htmlContent);
            setIsDefault(disclaimer.isDefault ?? false);
        }
    }, [disclaimer]);

    const handleSave = async () => {
        if (!name.trim()) {
            alert("Please enter a disclaimer name");
            return;
        }
        if (!htmlContent.trim()) {
            alert("Please enter the disclaimer content");
            return;
        }

        setIsSubmitting(true);
        try {
            if (isNew) {
                await createDisclaimer({ name, htmlContent, isDefault });
                router.push("/disclaimers");
            } else if (disclaimerId) {
                await updateDisclaimer({ id: disclaimerId, name, htmlContent, isDefault });
                router.push("/disclaimers");
            }
        } catch (error) {
            console.error(error);
            alert(`Failed to save disclaimer: ${error instanceof Error ? error.message : "Unknown error"}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isNew && disclaimer === undefined) {
        return <div className="p-8 text-center">Loading disclaimer...</div>;
    }

    if (!isNew && disclaimer === null) {
        return <div className="p-8 text-center">Disclaimer not found</div>;
    }

    return (
        <div className="flex flex-col h-screen">
            {/* Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Link href="/disclaimers" className="text-gray-500 hover:text-gray-700">
                        <ChevronLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-xl font-bold text-gray-900">
                            {isNew ? "Create New Disclaimer" : "Edit Disclaimer"}
                        </h1>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Disclaimer Name e.g. Legal / collections"
                            className="bg-transparent text-sm text-gray-600 outline-none w-full max-w-sm mt-1 focus:ring-1 focus:ring-blue-200 rounded px-1"
                        />
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => setIsDefault((d) => !d)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                            isDefault
                                ? "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                                : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                        }`}
                        title={
                            isDefault
                                ? "Suggested as the default in the picker — click to unset"
                                : "Not the default — click to mark as the suggested default"
                        }
                    >
                        <Star size={15} />
                        {isDefault ? "Default" : "Not default"}
                    </button>

                    <Link href="/disclaimers">
                        <Button variant="ghost">Cancel</Button>
                    </Link>
                    <Button onClick={handleSave} disabled={isSubmitting} className="gap-2">
                        <Save size={18} />
                        {isSubmitting ? "Saving..." : "Save Disclaimer"}
                    </Button>
                </div>
            </div>

            {/* Editor Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Disclaimer HTML
                        </label>
                        <p className="text-xs text-gray-500 mb-3">
                            Supports merge fields like <code className="bg-gray-100 px-1 rounded">{"{first_name}"}</code>,
                            resolved per recipient at send time.
                        </p>
                        <textarea
                            value={htmlContent}
                            onChange={(e) => setHtmlContent(e.target.value)}
                            placeholder="<p>This email and any attachments are confidential…</p>"
                            className="w-full h-[calc(100vh-320px)] font-mono text-sm border border-gray-200 rounded-md p-3 focus:ring-1 focus:ring-blue-200 outline-none resize-none"
                        />
                    </div>
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Preview
                        </label>
                        <p className="text-xs text-gray-500 mb-3">
                            How the disclaimer renders. Merge fields appear as their literal placeholders here.
                        </p>
                        <div
                            className="border border-gray-100 rounded-md p-4 bg-gray-50 min-h-[120px] text-sm text-gray-700"
                            dangerouslySetInnerHTML={{ __html: htmlContent }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
