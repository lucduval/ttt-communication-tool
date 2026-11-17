"use client";

import { useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/../convex/_generated/api";
import type { Doc } from "@/../convex/_generated/dataModel";
import { Button, Card } from "@/components/ui";
import { Loader2, Send, X } from "lucide-react";
import { orderedBodyVariables, validateForMeta } from "@/../convex/lib/whatsappTemplateCreate";

/** Plausible sample values for the Dynamics fields a variable can be mapped to. */
const SAMPLE_BY_FIELD: Record<string, string> = {
    fullname: "Thabo Mokoena",
    firstname: "Thabo",
    lastname: "Mokoena",
    mobilephone: "0821234567",
    emailaddress1: "thabo@example.com",
    parentcustomerid: "Mokoena Holdings",
    accountnumber: "ACC-10234",
    address1_composite: "12 Long Street, Cape Town",
    address1_city: "Cape Town",
    riivo_referralcode: "THABO25",
};

interface Props {
    template: Doc<"whatsappTemplates">;
    onClose: () => void;
}

export function SubmitToMetaModal({ template, onClose }: Props) {
    const submit = useAction(api.actions.whatsappTemplateAdmin.submitTemplateToMeta);

    const variables = useMemo(() => orderedBodyVariables(template.body), [template.body]);
    const mappings = useMemo<Record<string, string>>(() => {
        try {
            return template.variableMappings ? JSON.parse(template.variableMappings) : {};
        } catch {
            return {};
        }
    }, [template.variableMappings]);

    const [bodyExamples, setBodyExamples] = useState<Record<string, string>>(() =>
        Object.fromEntries(variables.map((v) => [v, SAMPLE_BY_FIELD[mappings[v]] ?? ""])),
    );
    const [button1, setButton1] = useState("");
    const [button2, setButton2] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ status: string; category: string } | null>(null);

    const dynamic1 = template.buttonType === "url" && !!template.buttonUrl?.includes("{{1}}");
    const dynamic2 = template.button2Type === "url" && !!template.button2Url?.includes("{{1}}");

    const examples = { body: bodyExamples, button1, button2 };
    const problems = validateForMeta(template, examples);

    const handleSubmit = async () => {
        setError(null);
        setSubmitting(true);
        try {
            const result = await submit({
                id: template._id,
                bodyExamples,
                button1Example: dynamic1 ? button1 : undefined,
                button2Example: dynamic2 ? button2 : undefined,
            });
            setDone(result);
        } catch (err) {
            const data = (err as { data?: unknown }).data;
            setError(typeof data === "string" ? data : err instanceof Error ? err.message : "Submission failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-lg font-bold text-gray-900">Submit to Meta for approval</h3>
                        <p className="text-xs text-gray-400 font-mono">
                            {template.metaTemplateId} · {template.language} · {template.category}
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
                        <X size={20} className="text-gray-500" />
                    </button>
                </div>

                {done ? (
                    <div className="space-y-4">
                        <p className="text-sm text-gray-700">
                            Meta accepted the template. Status: <strong>{done.status}</strong>, category:{" "}
                            <strong>{done.category}</strong>.
                        </p>
                        <p className="text-sm text-gray-500">
                            Review usually takes minutes but can take up to 24 hours. Use{" "}
                            <em>Sync from Meta</em> on the templates page to pick up the outcome. It can only be
                            used in campaigns once it is approved.
                        </p>
                        <div className="flex justify-end">
                            <Button onClick={onClose}>Close</Button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="p-3 bg-gray-50 rounded text-sm text-gray-700 whitespace-pre-wrap">
                            {template.body}
                        </div>

                        {variables.length > 0 && (
                            <div className="space-y-2">
                                <p className="text-sm font-medium text-gray-700">
                                    Sample values (Meta shows these to its reviewers; they are never sent)
                                </p>
                                {variables.map((v) => (
                                    <div key={v} className="flex items-center gap-3">
                                        <span className="w-28 shrink-0 text-xs font-mono text-green-700">{`{{${v}}}`}</span>
                                        <input
                                            type="text"
                                            value={bodyExamples[v] ?? ""}
                                            onChange={(e) => setBodyExamples({ ...bodyExamples, [v]: e.target.value })}
                                            className="w-full px-3 py-1.5 border border-gray-200 rounded-md text-sm"
                                        />
                                    </div>
                                ))}
                            </div>
                        )}

                        {dynamic1 && (
                            <ButtonSample label={template.buttonText} url={template.buttonUrl!} value={button1} onChange={setButton1} />
                        )}
                        {dynamic2 && (
                            <ButtonSample label={template.button2Text} url={template.button2Url!} value={button2} onChange={setButton2} />
                        )}

                        {template.headerType && template.headerType !== "none" && (
                            <p className="text-xs text-gray-500">
                                Header: {template.headerType}
                                {template.headerType === "text"
                                    ? ` — "${template.headerText}"`
                                    : " — the uploaded file is sent to Meta as the sample."}
                            </p>
                        )}

                        {problems.length > 0 && (
                            <ul className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded p-3 list-disc pl-5 space-y-1">
                                {problems.map((p) => (
                                    <li key={p}>{p}</li>
                                ))}
                            </ul>
                        )}
                        {error && (
                            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded p-3 whitespace-pre-wrap">
                                {error}
                            </p>
                        )}

                        <p className="text-xs text-gray-500">
                            This creates the template on the live WhatsApp Business Account that dev and prod share.
                            Meta doesn&apos;t allow editing the name afterwards.
                        </p>

                        <div className="flex justify-end gap-2">
                            <Button variant="secondary" onClick={onClose} disabled={submitting}>
                                Cancel
                            </Button>
                            <Button onClick={handleSubmit} disabled={submitting || problems.length > 0}>
                                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                                Submit to Meta
                            </Button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}

function ButtonSample(props: { label?: string; url: string; value: string; onChange: (v: string) => void }) {
    return (
        <div className="space-y-1">
            <p className="text-sm font-medium text-gray-700">
                Sample for “{props.label}” button <span className="font-mono text-xs text-gray-400">{props.url}</span>
            </p>
            <input
                type="text"
                value={props.value}
                placeholder="the part that replaces {{1}}"
                onChange={(e) => props.onChange(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-md text-sm"
            />
        </div>
    );
}
