"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Header } from "@/components/layout";
import { UserManagement } from "@/components/admin/UserManagement";
import { Button, Card } from "@/components/ui";
import { CheckCircle, RefreshCw, Sparkles } from "lucide-react";

export default function AdminUsersPage() {
    const backfill = useMutation(api.personalisedHistory.backfillFromExistingMessages);
    const [backfillState, setBackfillState] = useState<
        "idle" | "running" | { created: number; skipped: number }
    >("idle");

    const handleBackfill = async () => {
        setBackfillState("running");
        try {
            const result = await backfill({});
            setBackfillState(result);
        } catch (err) {
            console.error("Backfill failed:", err);
            setBackfillState("idle");
        }
    };

    return (
        <>
            <Header title="User Management" />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto space-y-8">
                    <div>
                        <div className="mb-6">
                            <h2 className="text-xl font-bold text-gray-900">Organization Settings</h2>
                            <p className="text-gray-500">Manage access and roles for your team.</p>
                        </div>
                        <UserManagement />
                    </div>

                    {/* Personalised Campaign History backfill */}
                    <div>
                        <div className="mb-4">
                            <h2 className="text-xl font-bold text-gray-900">Personalised Campaign History</h2>
                            <p className="text-gray-500">
                                Retroactively mark contacts who were sent personalised campaigns before history tracking was introduced.
                                This is safe to run multiple times — existing records are skipped.
                            </p>
                        </div>
                        <Card>
                            <div className="flex items-start justify-between gap-6">
                                <div className="flex items-start gap-3">
                                    <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0 mt-0.5">
                                        <Sparkles size={16} className="text-purple-600" />
                                    </div>
                                    <div>
                                        <p className="font-semibold text-gray-900">Backfill from sent messages</p>
                                        <p className="text-sm text-gray-500 mt-0.5">
                                            Scans all personalised messages with status&nbsp;<em>sent</em> or&nbsp;<em>delivered</em>
                                            &nbsp;and creates history records so those contacts are excluded from future campaigns with the same name.
                                        </p>
                                        {typeof backfillState === "object" && (
                                            <div className="mt-3 flex items-center gap-2 text-sm text-green-700">
                                                <CheckCircle size={15} />
                                                <span>
                                                    Done — <strong>{backfillState.created}</strong> record{backfillState.created !== 1 ? "s" : ""} created,&nbsp;
                                                    <strong>{backfillState.skipped}</strong> already existed.
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <Button
                                    variant="secondary"
                                    onClick={handleBackfill}
                                    disabled={backfillState === "running"}
                                    className="shrink-0"
                                >
                                    <RefreshCw size={15} className={backfillState === "running" ? "animate-spin" : ""} />
                                    {backfillState === "running" ? "Running…" : "Run Backfill"}
                                </Button>
                            </div>
                        </Card>
                    </div>
                </div>
            </section>
        </>
    );
}
