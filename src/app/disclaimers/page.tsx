"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Plus, Edit2, Archive, ScrollText, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Doc } from "../../../convex/_generated/dataModel";

export default function DisclaimersPage() {
    const disclaimers = useQuery(api.disclaimers.list);
    const currentUser = useQuery(api.users.getCurrentUser);
    const archiveDisclaimer = useMutation(api.disclaimers.archive);

    const [archivingId, setArchivingId] = useState<string | null>(null);

    const handleArchive = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        if (confirm("Archive this disclaimer? It will disappear from the picker but past campaigns that used it are unaffected.")) {
            setArchivingId(id);
            try {
                await archiveDisclaimer({ id: id as any });
            } catch (error) {
                console.error(error);
                alert("Failed to archive disclaimer");
            } finally {
                setArchivingId(null);
            }
        }
    };

    if (disclaimers === undefined || currentUser === undefined) {
        return <div className="p-8 text-center">Loading disclaimers...</div>;
    }

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-[#1E3A5F]">Disclaimers</h1>
                    <p className="text-gray-500 mt-2">Manage the legal disclaimers operators can append to campaigns</p>
                </div>
                <Link href="/disclaimers/new">
                    <Button className="gap-2">
                        <Plus size={18} />
                        Create Disclaimer
                    </Button>
                </Link>
            </div>

            {disclaimers.length === 0 ? (
                <Card className="p-12 text-center bg-gray-50 border-dashed">
                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <ScrollText className="text-blue-600" size={32} />
                    </div>
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No disclaimers yet</h3>
                    <p className="text-gray-500 mb-6 max-w-md mx-auto">
                        Create your first disclaimer so operators can append the right legal wording to a campaign.
                    </p>
                    <Link href="/disclaimers/new">
                        <Button variant="secondary">Create First Disclaimer</Button>
                    </Link>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {disclaimers.map((disclaimer: Doc<"disclaimers">) => {
                        const isArchiving = archivingId === disclaimer._id;

                        return (
                            <Card key={disclaimer._id} className="hover:shadow-lg transition-shadow duration-200">
                                <div className="p-6 flex flex-col h-full">
                                    <div className="flex-1">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-2 bg-blue-50 rounded text-blue-600">
                                                <ScrollText size={20} />
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {disclaimer.isDefault && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                                                        <Star size={11} />
                                                        Default
                                                    </span>
                                                )}
                                                <button
                                                    onClick={(e) => handleArchive(disclaimer._id, e)}
                                                    disabled={isArchiving}
                                                    className="text-gray-400 hover:text-red-500 p-1 disabled:opacity-50"
                                                    title="Archive"
                                                >
                                                    <Archive size={16} />
                                                </button>
                                            </div>
                                        </div>

                                        <h3 className="font-semibold text-lg text-gray-900 mb-1 truncate" title={disclaimer.name}>
                                            {disclaimer.name}
                                        </h3>
                                        <div
                                            className="text-sm text-gray-500 mb-4 line-clamp-3 [&_p]:m-0"
                                            dangerouslySetInnerHTML={{ __html: disclaimer.htmlContent }}
                                        />
                                        <div className="text-xs text-gray-400">
                                            Last updated: {new Date(disclaimer.lastUpdatedAt).toLocaleDateString()}
                                        </div>
                                    </div>

                                    <div className="mt-6 pt-4 border-t border-gray-100 flex gap-2">
                                        <Link href={`/disclaimers/${disclaimer._id}`} className="flex-1">
                                            <Button variant="secondary" className="w-full gap-2">
                                                <Edit2 size={14} />
                                                Edit Disclaimer
                                            </Button>
                                        </Link>
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
