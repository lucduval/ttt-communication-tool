"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const R = (n: number) => "R" + n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (ms?: number) =>
    ms ? new Date(ms).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" }) : "—";
const FILES = ["wa__30_60d", "wa__60d_plus", "email__30_60d", "email__60d_plus"] as const;
const STATUS: Record<string, "success" | "error" | "warning" | "info" | "default"> = {
    building: "info", review: "warning", sending: "info", sent: "success", paused: "error", failed: "error", cancelled: "default",
};

export default function BadDebtPage() {
    const data = useQuery(api.badDebtRuns.dashboard);
    const pause = useMutation(api.badDebtRuns.pauseRun);
    const resume = useMutation(api.badDebtRuns.resumeRun);
    const sendNow = useMutation(api.badDebtRuns.sendNow);
    const cancel = useMutation(api.badDebtRuns.cancelRun);
    const buildNow = useMutation(api.badDebtRuns.buildNow);
    const sendTest = useMutation(api.badDebtRuns.sendTest);
    const setHold = useMutation(api.badDebtRuns.setHold);
    const updateSettings = useMutation(api.badDebtRuns.updateSettings);
    const searchClients = useAction(api.actions.badDebtRun.searchClients);
    const [busy, setBusy] = useState(false);
    const [q, setQ] = useState("");
    const [found, setFound] = useState<Awaited<ReturnType<typeof searchClients>> | null>(null);

    if (data === undefined) return <div className="p-8 text-center">Loading…</div>;
    if (data === null) return <div className="p-8 text-center">Only an admin can see the bad-debt run.</div>;

    const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
        if (confirmText && !confirm(confirmText)) return;
        setBusy(true);
        try { await fn(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };

    const { settings, current, runs, replies, holds, campaignStatus } = data;
    const s = current?.summary as any;
    const byPerson = new Map<string, typeof replies>();
    for (const r of replies) byPerson.set(r.contactId, [...(byPerson.get(r.contactId) ?? []), r]);

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            <div className="flex justify-between items-start">
                <div>
                    <h1 className="text-3xl font-bold text-[#1E3A5F]">Bad-debt run</h1>
                    <p className="text-gray-500 mt-2">
                        Built every Monday 08:00, sent {settings?.reviewHours ?? "?"}h later unless paused.
                        {settings && !settings.enabled && <b className="text-red-600"> The weekly run is switched OFF.</b>}
                    </p>
                </div>
                <div className="flex gap-2">
                    {settings && (
                        <Button variant={settings.enabled ? "danger" : "secondary"} disabled={busy}
                            onClick={() => act(() => updateSettings({ enabled: !settings.enabled }),
                                settings.enabled ? "Switch the weekly run off? Nothing builds or sends until it is back on." : "Switch the weekly run on?")}>
                            {settings.enabled ? "Switch off" : "Switch on"}
                        </Button>
                    )}
                    <Button variant="secondary" disabled={busy}
                        onClick={() => act(() => buildNow({}), "Build a run now? It reads the CRM and mints any missing payment links, then waits for the review window before sending.")}>
                        Build now
                    </Button>
                </div>
            </div>

            {current && (
                <Card>
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <h2 className="text-xl font-semibold">Run {current.runNumber}</h2>
                            <Badge status={STATUS[current.status] ?? "default"}>{current.status}</Badge>
                        </div>
                        <div className="flex gap-2">
                            {["review", "paused"].includes(current.status) && current.builtAt && (
                                <Button variant="secondary" disabled={busy} onClick={() => {
                                    const phone = prompt("Send the test WhatsApp to which mobile?");
                                    if (!phone) return;
                                    const email = prompt("And the test email to which address?", "luc@riivo.io");
                                    if (!email) return;
                                    act(() => sendTest({ runId: current._id as Id<"badDebtRuns">, phone, email }));
                                }}>Send test to me</Button>
                            )}
                            {current.status === "review" && (
                                <>
                                    <Button variant="danger" disabled={busy} onClick={() => act(() => pause({ runId: current._id as Id<"badDebtRuns"> }))}>Pause</Button>
                                    <Button disabled={busy} onClick={() => act(() => sendNow({ runId: current._id as Id<"badDebtRuns"> }), "Send this run now?")}>Send now</Button>
                                </>
                            )}
                            {current.status === "paused" && current.builtAt && (
                                <Button disabled={busy} onClick={() => act(() => resume({ runId: current._id as Id<"badDebtRuns"> }), "Resume? It sends at the scheduled time, or in 10 minutes if that has passed.")}>Resume</Button>
                            )}
                            {["review", "paused", "failed"].includes(current.status) && (
                                <Button variant="ghost" disabled={busy} onClick={() => act(() => cancel({ runId: current._id as Id<"badDebtRuns"> }), "Cancel this run? It will never send.")}>Cancel run</Button>
                            )}
                        </div>
                    </div>
                    <div className="mt-3 text-sm text-gray-600 space-y-1">
                        <div>Built {when(current.builtAt)} · {current.status === "review" ? <b>sends {when(current.sendAt)}</b> : <>send time {when(current.sendAt)}</>}{current.sentAt && <> · sent {when(current.sentAt)}</>}</div>
                        {current.pauseReason && <div className="text-red-700"><b>Paused:</b> {current.pauseReason}</div>}
                        {(current.testCampaigns ?? []).map((t: any) => (
                            <div key={t.campaignId}>Test {t.channel} to {t.to} at {when(t.at)} — <a className="text-blue-600 underline" href={`/campaigns/${t.campaignId}`}>campaign</a></div>
                        ))}
                        {current.error && <pre className="text-red-700 whitespace-pre-wrap text-xs">{current.error.slice(0, 1500)}</pre>}
                    </div>

                    {s && (
                        <div className="grid md:grid-cols-2 gap-6 mt-4">
                            <div>
                                <div className="text-sm text-gray-500">
                                    {s.people} people · {s.messages} messages · {R(s.value)}
                                    {s.changePct !== null && <> · {s.changePct > 0 ? "+" : ""}{s.changePct}% vs last run ({s.prevPeople})</>}
                                </div>
                                <table className="w-full text-sm mt-2">
                                    <thead><tr className="text-left text-gray-500"><th>File</th><th className="text-right">People</th><th className="text-right">Value</th><th className="text-right">Campaign</th></tr></thead>
                                    <tbody>
                                        {FILES.map((f) => {
                                            const c = current.campaigns?.find((x: any) => x.file === f);
                                            const st = c ? campaignStatus[c.campaignId] : undefined;
                                            return (
                                                <tr key={f} className="border-t">
                                                    <td>{f}</td>
                                                    <td className="text-right">{s.files?.[f]?.people ?? 0}</td>
                                                    <td className="text-right">{R(s.files?.[f]?.value ?? 0)}</td>
                                                    <td className="text-right">{c ? <a className="text-blue-600 underline" href={`/campaigns/${c.campaignId}`}>{st ? `${st.status} ${st.sent}/${st.total}${st.failed ? `, ${st.failed} failed` : ""}` : "open"}</a> : "—"}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                <div className="text-xs text-gray-500 mt-2">
                                    Payment links: {s.tokens?.needed} needed, {s.tokens?.minted} minted{!s.tokens?.mintingOn && " (minting is off)"}
                                    {s.skipped?.length ? ` · ${s.skipped.length} skipped (no token / invoice number)` : ""}
                                    {" · "}{s.settledSincePull} settled during the build · {s.bouncedDropped} dropped from email for a past bounce
                                    {s.send && <> · at send: {s.send.dropped.held} held, {s.send.dropped.settled} settled</>}
                                </div>
                            </div>
                            <div>
                                <div className="text-sm text-gray-500">Excluded</div>
                                <table className="w-full text-sm mt-2">
                                    <tbody>
                                        {(s.excluded ?? []).map((e: any) => (
                                            <tr key={e.reason} className="border-t"><td>{e.reason}</td><td className="text-right">{e.people}</td><td className="text-right">{R(e.value)}</td></tr>
                                        ))}
                                    </tbody>
                                </table>
                                {(s.failures?.length > 0 || s.gateHeld?.length > 0 || s.gateWarnings?.length > 0) && (
                                    <div className="text-xs text-red-700 mt-2">
                                        {[...(s.failures ?? []), ...(s.gateWarnings ?? [])].map((f: string) => <div key={f}>{f}</div>)}
                                        {s.gateHeld?.length > 0 && <div>{s.gateHeld.length} row(s) held by the send gate</div>}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </Card>
            )}

            <Card>
                <h2 className="text-xl font-semibold">Replies since {s?.replies?.since?.slice(0, 10) ?? "the last run"} ({byPerson.size} people)</h2>
                <p className="text-sm text-gray-500 mt-1">
                    Read every one. The keyword guess missed all 7 real holds in run 13. Hold anyone who is disputing, says they have paid,
                    has an arrangement, or asked to stop. A hold takes effect at the send even if you add it after the build.
                </p>
                <div className="mt-4 divide-y">
                    {[...byPerson.entries()].map(([cid, msgs]) => {
                        const held = msgs[0].hold?.active === true;
                        return (
                            <div key={cid} className="py-3 flex gap-4">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <b>{msgs[0].name || cid}</b>
                                        <Badge status={held ? "error" : "default"}>{held ? `held (${msgs[0].hold?.source})` : "not held"}</Badge>
                                        <span className="text-xs text-gray-500">guess: {msgs[0].bucket}</span>
                                    </div>
                                    {msgs.slice(0, 5).map((m) => (
                                        <div key={m._id} className="text-sm text-gray-700 mt-1 break-words">
                                            <span className="text-xs text-gray-400">{m.channel} {m.at.slice(0, 16).replace("T", " ")} · </span>{m.text}
                                        </div>
                                    ))}
                                    {msgs.length > 5 && <div className="text-xs text-gray-400">+{msgs.length - 5} more</div>}
                                </div>
                                <div>
                                    <Button variant={held ? "secondary" : "danger"} disabled={busy}
                                        onClick={() => act(() => setHold({
                                            contactId: cid, name: msgs[0].name, hold: !held,
                                            reason: held ? undefined : (prompt("Why hold them? (e.g. disputes, says paid, arrangement)") ?? undefined),
                                        }))}>
                                        {held ? "Release" : "Hold"}
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                    {byPerson.size === 0 && <div className="py-3 text-gray-500">No replies.</div>}
                </div>
            </Card>

            <Card>
                <h2 className="text-xl font-semibold">Remove a client</h2>
                <p className="text-sm text-gray-500 mt-1">
                    Search by name, ID number, tax number, mobile or email, then hold them. A hold applies to the next send, including one already built.
                </p>
                <form className="flex gap-2 mt-3" onSubmit={(e) => { e.preventDefault(); act(async () => setFound(await searchClients({ q }))); }}>
                    <input className="flex-1 border rounded-md px-3 py-2" placeholder="e.g. 7801205008083, 0766580146 or Abdulla Kraft" value={q} onChange={(e) => setQ(e.target.value)} />
                    <Button type="submit" disabled={busy || q.trim().length < 3}>Search</Button>
                </form>
                {found && (
                    <div className="mt-3 divide-y text-sm">
                        {found.length === 0 && <div className="py-2 text-gray-500">No contact matches.</div>}
                        {found.map((c) => {
                            const held = holds.some((h) => h.contactId === c.contactId);
                            return (
                                <div key={c.contactId} className="py-2 flex justify-between gap-4">
                                    <div>
                                        <b>{c.name}</b>{!c.active && <span className="text-gray-400"> (inactive)</span>}
                                        <div className="text-gray-500">ID {c.idNumber || "—"} · tax {c.taxNumber || "—"} · {c.mobile || "no mobile"} · {c.email || "no email"}</div>
                                    </div>
                                    {held ? <Badge status="error">held</Badge> : (
                                        <Button variant="danger" disabled={busy} onClick={() => {
                                            const reason = prompt(`Why remove ${c.name}? (e.g. consultant request: old client)`);
                                            if (reason) act(() => setHold({ contactId: c.contactId, name: c.name, hold: true, reason }));
                                        }}>Hold</Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </Card>

            <Card>
                <h2 className="text-xl font-semibold">Hold list ({holds.length})</h2>
                <p className="text-sm text-gray-500 mt-1">Never chased while held. Nothing writes these to the CRM, so this list is the record.</p>
                <div className="mt-3 max-h-96 overflow-y-auto divide-y text-sm">
                    {holds.map((h) => (
                        <div key={h._id} className="py-2 flex justify-between gap-4">
                            <div><b>{h.name || h.contactId}</b> <span className="text-gray-500">— {h.reason} ({h.source})</span></div>
                            <Button variant="ghost" disabled={busy}
                                onClick={() => act(() => setHold({ contactId: h.contactId, name: h.name, hold: false }), `Release ${h.name || "this person"}? They will be chased from the next run.`)}>
                                Release
                            </Button>
                        </div>
                    ))}
                </div>
            </Card>

            <Card>
                <h2 className="text-xl font-semibold">Recent runs</h2>
                <table className="w-full text-sm mt-3">
                    <tbody>
                        {runs.map((r) => (
                            <tr key={r._id} className="border-t">
                                <td className="py-1">Run {r.runNumber}</td>
                                <td><Badge status={STATUS[r.status] ?? "default"}>{r.status}</Badge></td>
                                <td>built {when(r.builtAt)}</td>
                                <td>{r.sentAt ? `sent ${when(r.sentAt)}` : ""}</td>
                                <td className="text-gray-500">{r.trigger === "cron" ? "weekly" : "manual"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Card>
        </div>
    );
}
