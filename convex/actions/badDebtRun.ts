"use node";

/**
 * The weekly bad-debt run: build (Monday 08:00 SAST), send (end of the review
 * window), and the write-back of send counts to `riivo_baddebt`.
 *
 * This does what each hand-built run did (`.scratch/bad-debt-recovery/run13/RUNBOOK.md`):
 * pull the bad-debt records, open invoices and contacts live from the CRM, fold
 * the last run's results into the per-record message counts, read every reply
 * since the last run (WhatsApp from the CRM, email from the shared mailboxes via
 * Graph), choose who to chase, mint any missing payment links, build the four
 * files, check them, and put them through the wizard's own pre-send gate.
 *
 * It sends nothing at build time. The send waits out the review window and then
 * re-checks every invoice and every hold before creating the campaigns.
 */
import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getDynamicsAccessToken } from "../lib/dynamics_auth";
import { getGraphAccessToken, sendEmail } from "../lib/graph_client";
import {
    AMOUNT_FLOOR, RUN_FILES, STATUS_PAID, STATUS_PENDING_SETTLEMENT,
    buildRunFiles, isDoNotContact, round2, selectAudience,
    type BadDebtRow, type ContactRow, type InvoiceRow, type RunFile, type SystemUserRow,
} from "../lib/badDebtRun/audience";
import { checkRunFiles } from "../lib/badDebtRun/checks";
import { gateFile } from "../lib/badDebtRun/gate";
import { foldCampaign, writeBackPlan, type LedgerEntry } from "../lib/badDebtRun/ledger";
import { AUTO_HOLD_BUCKETS, classify, matchReplies, type InboundMessage } from "../lib/badDebtRun/replies";

/** The approved WhatsApp button prefix. The email link must use the same host. */
const PAY_HOST = "https://payment-link-ttt.azurewebsites.net";
/** Where clients reply to bad-debt email (run 10 onward). */
const REPLY_MAILBOXES = ["accounts@ttt-tax.co.za", "admin@ttt-tax.co.za"];
const WA_INBOUND = 463630000;
/** When a run has no predecessor, read replies this far back. */
const FIRST_RUN_REPLY_DAYS = 21;
/** Stagger the four campaigns so two WhatsApp or two email sends never compete. */
const START_OFFSETS_MIN: Record<RunFile, number> = {
    wa__30_60d: 1, wa__60d_plus: 3, email__30_60d: 1, email__60d_plus: 20,
};
const CAMPAIGN_SUFFIX: Record<RunFile, string> = {
    wa__30_60d: "wa_30_60d", wa__60d_plus: "wa_60d_3y", email__30_60d: "email_30_60d", email__60d_plus: "email_60d_3y",
};

// ─── Dataverse ──────────────────────────────────────────────────────────────

async function dv(path: string, init: RequestInit = {}): Promise<any> {
    const org = (process.env.DYNAMICS_ORG_URL ?? "").replace(/\/+$/, "");
    const url = path.startsWith("http") ? path : `${org}/api/data/v9.2/${path}`;
    for (let attempt = 1; ; attempt++) {
        const token = await getDynamicsAccessToken();
        const res = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json",
                "OData-MaxVersion": "4.0", "OData-Version": "4.0", Prefer: "odata.maxpagesize=5000",
                ...(init.headers ?? {}),
            },
        });
        if (res.ok) return res.status === 204 ? null : res.json();
        if ((res.status === 429 || res.status >= 500) && attempt < 5) {
            const wait = Number(res.headers.get("Retry-After")) || 2 * attempt;
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
        }
        throw new Error(`Dataverse ${init.method ?? "GET"} ${path.slice(0, 120)} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
}

async function dvAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
        const page: any = await dv(next);
        out.push(...page.value);
        next = page["@odata.nextLink"];
    }
    return out;
}

/** `entity?$select=…&$filter=(key eq a or key eq b …)` in batches of 30, a few at a time. */
async function dvByIds<T>(entity: string, select: string, key: string, ids: readonly string[], extraFilter = ""): Promise<T[]> {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 30) batches.push(ids.slice(i, i + 30) as string[]);
    const out: T[] = [];
    for (let i = 0; i < batches.length; i += 4) {
        const pages = await Promise.all(batches.slice(i, i + 4).map((b) => {
            const f = b.map((x) => `${key} eq ${x}`).join(" or ");
            return dvAll<T>(`${entity}?$select=${select}&$filter=${extraFilter ? `${extraFilter} and ` : ""}(${f})`);
        }));
        for (const p of pages) out.push(...p);
    }
    return out;
}

/** The effective value of a Dataverse environment variable: its value row, else its default. */
async function envVar(schemaName: string): Promise<string | null> {
    const r = await dv(
        `environmentvariabledefinitions?$select=defaultvalue&$filter=schemaname eq '${schemaName}'` +
        `&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)`,
    );
    const d = r.value[0];
    if (!d) return null;
    return d.environmentvariabledefinition_environmentvariablevalue?.[0]?.value ?? d.defaultvalue ?? null;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

const BD_SELECT = "riivo_baddebtid,statecode,_riivo_invoice_value,riivo_clientemail,riivo_clientmobile,riivo_clientfullname," +
    "createdon,riivo_campaignsendcount,riivo_campaignfirstsent,riivo_campaignlastsent,riivo_campaignlastreply," +
    "riivo_campaignbounced,riivo_baselineoutstanding,riivo_outstandingamount";
const INV_SELECT = "new_invoicesid,new_name,ttt_invoiceid,statecode,statuscode,ttt_outstanding,createdon," +
    "riivo_paymenttoken,_ttt_customer_value,_ownerid_value";
const CONTACT_SELECT = "contactid,firstname,fullname,emailaddress1,emailaddress2,emailaddress3,mobilephone," +
    "icon_formattedmobilenumber,telephone1,riivo_whatsappoptinout,donotemail,donotbulkemail,donotphone,statecode";

// ─── Replies ────────────────────────────────────────────────────────────────

async function inboundSince(since: string): Promise<InboundMessage[]> {
    const wa = await dvAll<any>(
        `riivo_whatsappcommunicationses?$select=description,riivo_from,createdon` +
        `&$filter=riivo_messagedirection eq ${WA_INBOUND} and createdon ge ${since}`,
    );
    const out: InboundMessage[] = wa.map((m) => ({
        channel: "whatsapp", from: m.riivo_from ?? "", at: m.createdon, text: (m.description ?? "").trim(),
    }));
    const token = await getGraphAccessToken();
    for (const mb of REPLY_MAILBOXES) {
        let url: string | undefined = `https://graph.microsoft.com/v1.0/users/${mb}/messages` +
            `?$filter=receivedDateTime ge ${since}&$select=from,receivedDateTime,subject,bodyPreview,isDraft&$top=200`;
        while (url) {
            const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
            if (!res.ok) throw new Error(`Graph ${mb} → ${res.status} ${(await res.text()).slice(0, 200)}`);
            const page: any = await res.json();
            for (const m of page.value) {
                if (m.isDraft) continue;
                out.push({
                    channel: "email", from: m.from?.emailAddress?.address ?? "", at: m.receivedDateTime,
                    text: `${m.subject ?? ""} — ${(m.bodyPreview ?? "").slice(0, 400)}`.trim(),
                });
            }
            url = page["@odata.nextLink"];
        }
    }
    return out;
}

// ─── Minting ────────────────────────────────────────────────────────────────

async function mintMissing(invoiceIds: readonly string[], base: string): Promise<{ minted: number; errors: string[] }> {
    const key = await envVar("riivo_PaymentLink_FunctionKey");
    if (!key) throw new Error("riivo_PaymentLink_FunctionKey has no value");
    let minted = 0;
    const errors: string[] = [];
    for (const inv of invoiceIds) {
        try {
            const cur = await dv(`new_invoiceses(${inv})?$select=riivo_paymenttoken,statecode,ttt_outstanding`);
            if (cur.riivo_paymenttoken || cur.statecode !== 0 || !(cur.ttt_outstanding > 0)) continue;
            const res = await fetch(`${base}/mint-token`, {
                method: "POST", headers: { "Content-Type": "application/json", "x-functions-key": key },
                body: JSON.stringify({ invoiceId: inv }),
            });
            if (!res.ok) throw new Error(`mint ${res.status} ${(await res.text()).slice(0, 200)}`);
            const raw = await res.text();
            let tok: string;
            try {
                const j = JSON.parse(raw);
                tok = typeof j === "string" ? j : j.token ?? j.paymentToken ?? j.value;
            } catch {
                tok = raw.trim().replace(/^"|"$/g, "");
            }
            if (!tok) throw new Error(`no token in mint response: ${raw.slice(0, 200)}`);
            const after = await dv(`new_invoiceses(${inv})?$select=riivo_paymenttoken`);
            if (after.riivo_paymenttoken !== tok) {
                await dv(`new_invoiceses(${inv})`, { method: "PATCH", body: JSON.stringify({ riivo_paymenttoken: tok }) });
            }
            minted++;
        } catch (e) {
            errors.push(`${inv}: ${String(e).slice(0, 200)}`);
        }
    }
    return { minted, errors };
}

// ─── Notifications ──────────────────────────────────────────────────────────

async function notify(ctx: ActionCtx, subject: string, html: string) {
    const s = await ctx.runQuery(internal.badDebtRuns.getSettings, {});
    if (!s?.notifyEmails.length) return;
    const link = `${process.env.SITE_URL ?? ""}/bad-debt`;
    const res = await sendEmail({
        subject, fromMailbox: s.emailFromMailbox,
        toRecipients: s.notifyEmails.map((email) => ({ email })),
        body: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">${html}<p><a href="${link}">Open the bad-debt run</a></p></div>`,
        saveToSentItems: false,
    });
    if (!res.success) console.error("bad-debt notify failed:", res.error);
}

const R = (n: number) => "R" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const sast = (ms: number) => new Date(ms).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" });

// ─── Build ──────────────────────────────────────────────────────────────────

export const buildRun = internalAction({
    args: { trigger: v.string() },
    handler: async (ctx, { trigger }) => {
        const runId: Id<"badDebtRuns"> | null = await ctx.runMutation(internal.badDebtRuns.openRun, { trigger });
        if (!runId) {
            console.log("bad-debt build skipped: switched off, or a run is already in flight");
            return;
        }
        try {
            await build(ctx, runId);
        } catch (e) {
            const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
            await ctx.runMutation(internal.badDebtRuns.failRun, { runId, error: msg });
            await notify(ctx, "Bad-debt run FAILED to build", `<p>Nothing was sent.</p><pre>${esc(msg.slice(0, 2000))}</pre>`);
        }
    },
});

/** Exported for the local dry-run harness; production enters through {@link buildRun}. */
export async function build(ctx: ActionCtx, runId: Id<"badDebtRuns">) {
    const settings = (await ctx.runQuery(internal.badDebtRuns.getSettings, {}))!;
    const run = (await ctx.runQuery(internal.badDebtRuns.getRun, { runId }))!;
    const today = new Date();

    // 1. Fold every finished campaign of earlier runs into the ledger, so counts and bounces are current.
    let inputs = await ctx.runQuery(internal.badDebtRuns.getBuildInputs, {});
    const folded: string[] = [];
    for (const prev of inputs.runs) {
        for (const c of prev.campaigns ?? []) {
            if (c.folded) continue;
            const doc = await ctx.runQuery(internal.campaignBatches.getCampaign, { campaignId: c.campaignId });
            if (!doc || !["completed", "failed"].includes(doc.status)) continue;
            const recips = await ctx.runQuery(internal.badDebtRuns.recipientsForFile, { runId: prev._id, file: c.file });
            const map = new Map(recips.map((r) => [r.contactId, r.badDebtId]));
            const ledger = new Map<string, LedgerEntry>(inputs.ledger.map((e) => [e.badDebtId, e]));
            const msgs = await ctx.runQuery(internal.badDebtRuns.campaignMessages, { campaignId: c.campaignId });
            const fold = foldCampaign(ledger, msgs, map);
            await ctx.runMutation(internal.badDebtRuns.applyFold, {
                runId: prev._id, campaignId: c.campaignId, entries: [...fold.entries.values()], bounces: fold.bounces,
            });
            folded.push(`run ${prev.runNumber} ${c.file}`);
            inputs = await ctx.runQuery(internal.badDebtRuns.getBuildInputs, {});
        }
    }

    // 2. The pool, live.
    const badDebts = await dvAll<BadDebtRow>(`riivo_baddebts?$select=${BD_SELECT}`);
    const openInvoices = await dvAll<InvoiceRow>(`new_invoiceses?$select=${INV_SELECT}&$filter=statecode eq 0`);
    const openById = new Map(openInvoices.map((i) => [lower(i.new_invoicesid), i]));
    const poolCustomers = [...new Set(badDebts
        .map((b) => lower(openById.get(lower(b._riivo_invoice_value))?._ttt_customer_value))
        .filter(Boolean))];
    const contactRows = await dvByIds<ContactRow>("contacts", CONTACT_SELECT, "contactid", poolCustomers);
    const contacts = new Map(contactRows.map((c) => [lower(c.contactid), c]));

    // 3. Replies since the last run was built. Keyword-held people are held now; everyone is listed to read.
    const lastBuilt = inputs.runs.find((r) => r._id !== runId && r.builtAt)?.builtAt;
    const since = new Date(lastBuilt ?? today.getTime() - FIRST_RUN_REPLY_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z";
    const matched = matchReplies(await inboundSince(since), contactRows);
    const byPerson = new Map<string, typeof matched>();
    for (const m of matched) byPerson.set(m.contactId, [...(byPerson.get(m.contactId) ?? []), m]);
    const holds = new Set(inputs.holds);
    const released = new Set(inputs.released);
    const replies: { contactId: string; name: string; channel: string; at: string; text: string; bucket: string }[] = [];
    const autoHolds: { contactId: string; name: string; reason: string }[] = [];
    for (const [cid, msgs] of byPerson) {
        const bucket = classify(msgs.map((m) => m.text));
        const name = (contacts.get(cid)?.fullname ?? "").trim();
        for (const m of msgs) replies.push({ contactId: cid, name, channel: m.channel, at: m.at, text: m.text.slice(0, 1000), bucket });
        if (AUTO_HOLD_BUCKETS.has(bucket) && !holds.has(cid) && !released.has(cid)) {
            autoHolds.push({ contactId: cid, name, reason: `replied: ${bucket}` });
            holds.add(cid);
        }
    }
    for (let i = 0; i < replies.length || i === 0; i += 200) {
        await ctx.runMutation(internal.badDebtRuns.saveReplies, {
            runId, replies: replies.slice(i, i + 200), autoHolds: i === 0 ? autoHolds : [],
        });
        if (replies.length === 0) break;
    }

    // 4. Who is chased.
    const ledger = new Map(inputs.ledger.map((e) => [e.badDebtId, e]));
    const crmCount = new Map(badDebts.map((b) => [lower(b.riivo_baddebtid), b.riivo_campaignsendcount ?? 0]));
    const messagesBefore = new Map<string, number>();
    for (const id of new Set([...ledger.keys(), ...crmCount.keys()])) {
        messagesBefore.set(id, Math.max(ledger.get(id)?.n ?? 0, crmCount.get(id) ?? 0));
    }
    const { chosen, excluded } = selectAudience({ badDebts, openInvoices, contacts, holds, messagesBefore, today });

    // 5. Payment links. The email button and the WhatsApp button must point at the same host.
    const base = ((await envVar("riivo_PaymentLink_BaseUrl")) ?? "").replace(/\/+$/, "");
    const pauses: string[] = [];
    if (base !== PAY_HOST) pauses.push(`riivo_PaymentLink_BaseUrl is ${base || "blank"}, but the WhatsApp button points at ${PAY_HOST}`);
    const needToken = chosen.filter((c) => !(openById.get(c.invoiceId)?.riivo_paymenttoken ?? "").trim()).map((c) => c.invoiceId);
    let mint = { minted: 0, errors: [] as string[] };
    if (needToken.length && settings.mintTokens && !pauses.length) mint = await mintMissing(needToken, base);

    // 6. Re-read the chosen invoices (live, after minting), their owners, and paid history.
    const invIds = chosen.map((c) => c.invoiceId);
    const live = await dvByIds<InvoiceRow>("new_invoiceses", INV_SELECT, "new_invoicesid", invIds);
    const invoices = new Map(live.map((i) => [lower(i.new_invoicesid), i]));
    // Settled since the pool was read: dropped here, as enrich13.py did.
    let settled = 0;
    const stillOpen = chosen.filter((c) => {
        const i = invoices.get(c.invoiceId);
        const ok = !!i && i.statecode === 0 && (i.ttt_outstanding ?? 0) > AMOUNT_FLOOR &&
            i.statuscode !== STATUS_PAID && i.statuscode !== STATUS_PENDING_SETTLEMENT;
        if (!ok) settled++;
        return ok;
    });
    const owners = [...new Set(live.map((i) => lower(i._ownerid_value)).filter(Boolean))];
    const users = new Map((await dvByIds<SystemUserRow>("systemusers", "systemuserid,fullname,internalemailaddress,isdisabled", "systemuserid", owners))
        .map((u) => [lower(u.systemuserid), u]));
    const paidRows = await dvByIds<InvoiceRow>("new_invoiceses", "new_invoicesid,_ttt_customer_value", "_ttt_customer_value",
        [...new Set(stillOpen.map((c) => c.contactId))], `statuscode eq ${STATUS_PAID}`);
    const paidCounts = new Map<string, number>();
    for (const p of paidRows) paidCounts.set(lower(p._ttt_customer_value), (paidCounts.get(lower(p._ttt_customer_value)) ?? 0) + 1);

    const bounced = new Map<string, Set<string>>();
    for (const b of inputs.bounces) bounced.set(b.contactId, (bounced.get(b.contactId) ?? new Set()).add(b.address));

    // 7. The files, the checks, and the wizard's gate.
    const label = `run${run.runNumber}`;
    const built = buildRunFiles({
        chosen: stillOpen, contacts, invoices, users, paidCounts, bounced, paymentLinkBase: PAY_HOST, runLabel: label, today,
    });
    const doNotContact = new Set([...contacts].filter(([, c]) => isDoNotContact(c)).map(([id]) => id));
    const disabledMailboxes = new Set([...users.values()].filter((u) => u.isdisabled).map((u) => lower(u.internalemailaddress)));
    const failures = checkRunFiles(built.files, { paymentLinkBase: PAY_HOST, holds, doNotContact, bounced, disabledMailboxes });

    const tpl = await ctx.runQuery(internal.whatsappTemplates.getByIdInternal, { id: settings.whatsappTemplateId });
    if (!tpl) throw new Error(`WhatsApp template ${settings.whatsappTemplateId} not found`);
    const template = { variables: tpl.variables, variableMappings: tpl.variableMappings, buttonUrlVariable: tpl.buttonUrlVariable, button2UrlVariable: (tpl as any).button2UrlVariable };
    const files: Record<string, { people: number; value: number; held: number }> = {};
    const gateHeld: { file: string; id: string; reasons: string[] }[] = [];
    const gateWarnings: string[] = [];
    for (const f of RUN_FILES) {
        const rows = built.files[f];
        const g = f.startsWith("wa__")
            ? gateFile(rows, "whatsapp", { template })
            : gateFile(rows, "email", { subject: settings.emailSubject, htmlBody: settings.emailHtmlBody });
        for (const h of g.held) gateHeld.push({ file: f, ...h });
        for (const w of g.warnings) gateWarnings.push(`${f}: ${w}`);
        const byId = new Map(rows.map((r) => [r["Contact ID"], r]));
        const save = g.recipients.map((rec) => {
            const r = byId.get(rec.id)!;
            return { file: f, contactId: rec.id, badDebtId: r.bad_debt_id, invoiceId: r.invoice_id, amount: Number(r.amount), recipient: rec };
        });
        for (let i = 0; i < save.length; i += 200) {
            await ctx.runMutation(internal.badDebtRuns.saveRecipients, { runId, rows: save.slice(i, i + 200) });
        }
        files[f] = { people: save.length, value: round2(save.reduce((s, r) => s + r.amount, 0)), held: g.held.length };
    }

    // 8. Guards. Any of these pauses the run; a reviewer can still resume it.
    const people = new Set(RUN_FILES.flatMap((f) => built.files[f].map((r) => r["Contact ID"])));
    const value = round2([...people].reduce((s, id) => {
        const r = RUN_FILES.map((f) => built.files[f].find((x) => x["Contact ID"] === id)).find(Boolean)!;
        return s + Number(r.amount);
    }, 0));
    const prevPeople = inputs.runs.find((r) => r._id !== runId && r.status === "sent")?.summary?.people ?? settings.baselinePeople;
    const changePct = prevPeople ? Math.round(((people.size - prevPeople) / prevPeople) * 100) : null;
    if (changePct !== null && Math.abs(changePct) > settings.maxChangePercent) {
        pauses.push(`audience is ${people.size}, ${changePct > 0 ? "+" : ""}${changePct}% against the last run's ${prevPeople}`);
    }
    if (failures.length) pauses.push(`${failures.length} pre-send check(s) failed: ${failures.join("; ")}`);
    if (gateWarnings.length) pauses.push(`the send gate warned: ${gateWarnings.join("; ")}`);
    if (gateHeld.length) pauses.push(`the send gate held ${gateHeld.length} row(s)`);
    if (mint.errors.length) pauses.push(`${mint.errors.length} payment link(s) failed to mint`);
    if (people.size === 0) pauses.push("nobody to send to");

    const summary = {
        people: people.size, value, messages: RUN_FILES.reduce((s, f) => s + files[f].people, 0),
        files, excluded, changePct, prevPeople,
        settledSincePull: settled,
        skipped: built.skipped, unreachableAtBuild: built.unreachable.length, bouncedDropped: built.bouncedDropped,
        tokens: { needed: needToken.length, minted: mint.minted, errors: mint.errors, mintingOn: settings.mintTokens },
        replies: { since, people: byPerson.size, autoHeld: autoHolds.length },
        holds: holds.size, folded, failures, gateHeld, gateWarnings,
        poolRecords: badDebts.length,
    };
    const pauseReason = pauses.length ? pauses.join(" · ") : undefined;
    const { sendAt } = await ctx.runMutation(internal.badDebtRuns.finishBuild, { runId, summary, repliesSince: since, pauseReason });

    // 9. Write the counts back to the CRM (monotonic), now that the ledger is folded.
    if (settings.writeBackStats) {
        const lastReply = new Map<string, string>();
        const bdByCustomer = new Map<string, string[]>();
        for (const b of badDebts) {
            const cust = lower(openById.get(lower(b._riivo_invoice_value))?._ttt_customer_value);
            if (cust) bdByCustomer.set(cust, [...(bdByCustomer.get(cust) ?? []), lower(b.riivo_baddebtid)]);
        }
        for (const [cid, msgs] of byPerson) {
            const latest = msgs.map((m) => m.at).sort().at(-1)!;
            for (const bd of bdByCustomer.get(cid) ?? []) lastReply.set(bd, latest);
        }
        const fresh = await ctx.runQuery(internal.badDebtRuns.getBuildInputs, {});
        const plan = writeBackPlan(fresh.ledger, new Map(badDebts.map((b) => [lower(b.riivo_baddebtid), b])), lastReply);
        if (plan.length) await ctx.scheduler.runAfter(0, internal.actions.badDebtRun.writeBack, { patches: plan });
    }

    // 10. Tell the reviewer.
    const fileRows = RUN_FILES.map((f) =>
        `<tr><td>${f}</td><td align="right">${files[f].people}</td><td align="right">${R(files[f].value)}</td></tr>`).join("");
    const exclRows = excluded.map((e) => `<tr><td>${esc(e.reason)}</td><td align="right">${e.people}</td><td align="right">${R(e.value)}</td></tr>`).join("");
    const head = pauseReason
        ? `<p style="color:#b00"><b>PAUSED — nothing will send until someone resumes it.</b><br>${esc(pauseReason)}</p>`
        : `<p><b>Sends ${sast(sendAt!)}</b> unless you pause it. Read the replies and hold anyone who should not be chased before then.</p>`;
    await notify(ctx, `Bad-debt run ${run.runNumber}: ${people.size} people, ${R(value)}${pauseReason ? " — PAUSED" : ""}`, `
        ${head}
        <p>${byPerson.size} people replied since ${since.slice(0, 10)}; ${autoHolds.length} held automatically by keyword.
        ${byPerson.size ? "<b>The keyword check misses most real holds, so read them.</b>" : ""}</p>
        <table cellpadding="4" style="border-collapse:collapse">${fileRows}</table>
        <p>Excluded:</p><table cellpadding="4">${exclRows}</table>
        <p>Payment links: ${needToken.length} needed, ${mint.minted} minted${settings.mintTokens ? "" : " (minting is off)"}${built.skipped.length ? `; ${built.skipped.length} skipped for no token or invoice number` : ""}.</p>`);
}

// ─── Send ───────────────────────────────────────────────────────────────────

export const sendRun = internalAction({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => {
        const claimed = await ctx.runMutation(internal.badDebtRuns.claimSend, { runId });
        if (!claimed) return;
        const run = (await ctx.runQuery(internal.badDebtRuns.getRun, { runId }))!;
        try {
            // Re-check what may have changed in the review window: holds added, invoices settled.
            const holds = new Set(await ctx.runQuery(internal.badDebtRuns.activeHoldIds, {}));
            const perFile = new Map<RunFile, Awaited<ReturnType<typeof loadFile>>>();
            for (const f of RUN_FILES) perFile.set(f, await loadFile(ctx, runId, f));
            const invIds = [...new Set([...perFile.values()].flat().map((r) => r.invoiceId))];
            const live = new Map((await dvByIds<InvoiceRow>("new_invoiceses", "new_invoicesid,statecode,statuscode,ttt_outstanding", "new_invoicesid", invIds))
                .map((i) => [lower(i.new_invoicesid), i]));
            const dropped = { held: 0, settled: 0 };
            const report: Record<string, number> = {};
            for (const f of RUN_FILES) {
                const recips = perFile.get(f)!.filter((r) => {
                    if (holds.has(r.contactId)) { dropped.held++; return false; }
                    const i = live.get(r.invoiceId);
                    if (!i || i.statecode !== 0 || (i.ttt_outstanding ?? 0) <= AMOUNT_FLOOR ||
                        i.statuscode === STATUS_PAID || i.statuscode === STATUS_PENDING_SETTLEMENT) { dropped.settled++; return false; }
                    return true;
                }).map((r) => r.recipient);
                report[f] = recips.length;
                if (!recips.length) continue;
                await ctx.runMutation(internal.badDebtRuns.createRunCampaign, {
                    runId, file: f, name: `bad_debt_run${run.runNumber}_${CAMPAIGN_SUFFIX[f]}`,
                    channel: f.startsWith("wa__") ? "whatsapp" : "email",
                    recipients: recips, startAt: Date.now() + START_OFFSETS_MIN[f] * 60_000,
                });
            }
            await ctx.runMutation(internal.badDebtRuns.markSent, { runId, sendReport: { campaigns: report, dropped } });
            await notify(ctx, `Bad-debt run ${run.runNumber} is sending`, `
                <p>${Object.entries(report).map(([f, n]) => `${f}: ${n}`).join("<br>")}</p>
                <p>Dropped at send: ${dropped.held} held during review, ${dropped.settled} settled since the build.</p>`);
        } catch (e) {
            const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
            await ctx.runMutation(internal.badDebtRuns.failRun, { runId, error: msg });
            await notify(ctx, `Bad-debt run ${run.runNumber} FAILED while sending`,
                `<p>Check the Campaigns page: any campaign already created is scheduled and will send unless paused there.</p><pre>${esc(msg.slice(0, 2000))}</pre>`);
        }
    },
});

export const sendTestRun = internalAction({
    args: { runId: v.id("badDebtRuns"), phone: v.string(), email: v.string() },
    handler: async (ctx, { runId, phone, email }) => {
        const run = (await ctx.runQuery(internal.badDebtRuns.getRun, { runId }))!;
        const to = { phone: phone.replace(/\D/g, "").replace(/^0/, "27"), email: email.trim() };
        const pick = async (files: RunFile[]) => {
            for (const f of files) {
                const rows = await loadFile(ctx, runId, f);
                if (rows.length) return { file: f, row: rows[0] };
            }
            return null;
        };
        const sent: string[] = [];
        for (const [channel, files] of [["whatsapp", ["wa__30_60d", "wa__60d_plus"]], ["email", ["email__30_60d", "email__60d_plus"]]] as const) {
            const hit = await pick([...files]);
            if (!hit) continue;
            const vars = JSON.parse(hit.row.recipient.variables ?? "{}");
            vars.mobile = to.phone;
            vars.email = to.email;
            vars.consultant_email = ""; // never CC a consultant on a test
            const recipient = {
                ...hit.row.recipient,
                phone: channel === "whatsapp" ? to.phone : undefined,
                email: channel === "email" ? to.email : undefined,
                variables: JSON.stringify(vars),
            };
            await ctx.runMutation(internal.badDebtRuns.createRunCampaign, {
                runId, file: hit.file, name: `bad_debt_run${run.runNumber}_TEST_${channel}`, channel,
                recipients: [recipient], startAt: Date.now() + 60_000,
                testTo: channel === "whatsapp" ? to.phone : to.email,
            });
            sent.push(`${channel} → ${channel === "whatsapp" ? to.phone : to.email} (as ${hit.row.recipient.name}, ${vars.amount_formatted})`);
        }
        console.log("bad-debt test send:", sent);
    },
});

async function loadFile(ctx: ActionCtx, runId: Id<"badDebtRuns">, file: RunFile) {
    return await ctx.runQuery(internal.badDebtRuns.recipientsForFile, { runId, file });
}

// ─── Remove a client ────────────────────────────────────────────────────────

/**
 * Find CRM contacts to hold out of the run, e.g. a consultant asking for named
 * clients to stop getting reminders. Matches a 13-digit ID number, a tax number,
 * a mobile, an email address, or part of a name.
 */
export const searchClients = action({
    args: { q: v.string() },
    handler: async (ctx, { q }): Promise<{ contactId: string; name: string; idNumber: string; taxNumber: string; mobile: string; email: string; active: boolean }[]> => {
        const access = await ctx.runQuery(api.users.checkAccess, {});
        if (!access.hasAccess || access.user?.role !== "admin") throw new Error("Only an admin can do this");
        const term = q.trim().replace(/'/g, "''");
        if (term.length < 3) return [];
        const digits = term.replace(/\D/g, "");
        let filter: string;
        if (term.includes("@")) filter = `emailaddress1 eq '${term}' or emailaddress2 eq '${term}' or emailaddress3 eq '${term}'`;
        else if (digits.length >= 6 && digits.length === term.replace(/[\s+-]/g, "").length) {
            const local = digits.startsWith("27") ? "0" + digits.slice(2) : digits;
            filter = [`ttt_idnumber eq '${digits}'`, `ttt_taxnumber eq '${digits}'`, `mobilephone eq '${local}'`,
                `mobilephone eq '${digits}'`, `icon_formattedmobilenumber eq '${digits}'`].join(" or ");
        } else filter = term.split(/\s+/).map((w) => `contains(fullname,'${w}')`).join(" and ");
        const rows = await dv(`contacts?$select=contactid,fullname,ttt_idnumber,ttt_taxnumber,mobilephone,emailaddress1,statecode&$top=25&$filter=${encodeURIComponent(filter)}`);
        return rows.value.map((c: any) => ({
            contactId: lower(c.contactid), name: c.fullname ?? "", idNumber: c.ttt_idnumber ?? "", taxNumber: c.ttt_taxnumber ?? "",
            mobile: c.mobilephone ?? "", email: c.emailaddress1 ?? "", active: c.statecode === 0,
        }));
    },
});

// ─── Write-back ─────────────────────────────────────────────────────────────

/** PATCH `riivo_baddebt` campaign fields, 300 per invocation, re-scheduling the rest. */
export const writeBack = internalAction({
    args: { patches: v.array(v.object({ id: v.string(), fields: v.any() })) },
    handler: async (ctx, { patches }) => {
        const now = patches.slice(0, 300);
        const errors: string[] = [];
        for (let i = 0; i < now.length; i += 4) {
            await Promise.all(now.slice(i, i + 4).map(async (p) => {
                try {
                    await dv(`riivo_baddebts(${p.id})`, { method: "PATCH", body: JSON.stringify(p.fields), headers: { "If-Match": "*" } });
                } catch (e) {
                    errors.push(`${p.id}: ${String(e).slice(0, 160)}`);
                }
            }));
        }
        if (errors.length) console.error(`bad-debt write-back: ${errors.length} failed`, errors.slice(0, 5));
        if (patches.length > 300) await ctx.scheduler.runAfter(0, internal.actions.badDebtRun.writeBack, { patches: patches.slice(300) });
        else console.log("bad-debt write-back finished");
    },
});
