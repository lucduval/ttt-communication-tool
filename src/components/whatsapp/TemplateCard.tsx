"use client";

import { Badge } from "@/components/ui";
import type { Doc } from "@/../convex/_generated/dataModel";

interface TemplateCardProps {
    template: Doc<"whatsappTemplates">;
    isSelected: boolean;
    onSelect: () => void;
}

export function TemplateCard({ template, isSelected, onSelect }: TemplateCardProps) {
    const categoryColors: Record<string, string> = {
        marketing: "bg-purple-100 text-purple-700 border-purple-200",
        utility: "bg-blue-100 text-blue-700 border-blue-200",
        authentication: "bg-amber-100 text-amber-700 border-amber-200",
    };

    // Highlight variables in the body text
    const highlightVariables = (text: string) => {
        const parts = text.split(/(\{\{[^}]+\}\})/g);
        return parts.map((part, index) => {
            if (part.match(/^\{\{[^}]+\}\}$/)) {
                return (
                    <span
                        key={index}
                        className="bg-green-100 text-green-700 px-1 rounded font-medium"
                    >
                        {part}
                    </span>
                );
            }
            return part;
        });
    };

    return (
        <div
            onClick={onSelect}
            className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${isSelected
                ? "border-[#1E3A5F] bg-[#1E3A5F]/5 shadow-md"
                : "border-gray-100 hover:border-gray-200"
                }`}
        >
            <div className="flex flex-col items-start gap-2 mb-3">
                <h4 className="font-bold text-gray-900 break-words w-full">{template.name}</h4>
                <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium border ${categoryColors[template.category] || "bg-gray-100 text-gray-600"
                        }`}
                >
                    {template.category}
                </span>
            </div>
            <p className="text-sm text-gray-600 mb-3 line-clamp-3">
                {highlightVariables(template.body)}
            </p>
            <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">{template.language}</span>
                <Badge status={template.status === "approved" ? "success" : "warning"}>
                    {template.status}
                </Badge>
            </div>
        </div>
    );
}
