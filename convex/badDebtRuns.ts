/**
 * Weekly bad-debt run — state, review controls, and campaign creation.
 *
 * Lifecycle of one run:
 *   building  the build action is reading the CRM and assembling the files
 *   review    built; the send is scheduled `reviewHours` later. A reviewer reads the
 *             replies, holds anyone who should not be chased, or pauses the run
 *   sending   the send action has claimed the run and is creating campaigns
 *   sent      four campaigns exist (or fewer, if a file was empty)
 *   paused    stopped by a reviewer or by a guard (audience swing, failed check);
 *             nothing goes out until someone resumes it
 *   cancelled / failed
 *
 * The heavy lifting is in `actions/badDebtRun.ts`; the pure rules are in
 * `lib/badDebtRun/`.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { checkAdminAccess } from "./users";
import { startCampaignImpl } from "./campaignBatches";
import { RUN_COLUMN_ROLES, RUN_WHATSAPP_MAPPING } from "./lib/badDebtRun/constants";

const ACTIVE = ["building", "review", "sending"];

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
    const identity = await checkAdminAccess(ctx);
    if (!identity) throw new Error("Only an admin can do this");
    return identity;
}

async function settingsOrThrow(ctx: QueryCtx | MutationCtx): Promise<Doc<"badDebtSettings">> {
    const s = await ctx.db.query("badDebtSettings").first();
    if (!s) throw new Error("badDebtSettings has not been set up (run badDebtRuns:setup)");
    return s;
}

// ─── Read side, for the actions ─────────────────────────────────────────────

export const getSettings = internalQuery({
    args: {},
    handler: async (ctx) => await ctx.db.query("badDebtSettings").first(),
});

export const getRun = internalQuery({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => await ctx.db.get(runId),
});

export const getBuildInputs = internalQuery({
    args: {},
    handler: async (ctx) => {
        const holds = await ctx.db.query("badDebtHolds").withIndex("by_active", (q) => q.eq("active", true)).collect();
        const released = await ctx.db.query("badDebtHolds").withIndex("by_active", (q) => q.eq("active", false)).collect();
        const ledger = await ctx.db.query("badDebtLedger").collect();
        const bounces = await ctx.db.query("badDebtBounces").collect();
        const runs = await ctx.db.query("badDebtRuns").withIndex("by_run_number").order("desc").take(10);
        return {
            holds: holds.map((h) => h.contactId),
            // A reviewer's "not a hold" outlives the next keyword match on the same person.
            released: released.filter((h) => h.source === "reviewer").map((h) => h.contactId),
            ledger: ledger.map(({ badDebtId, n, first, last, bounced, fails }) => ({ badDebtId, n, first, last, bounced, fails })),
            bounces: bounces.map(({ contactId, address }) => ({ contactId, address })),
            runs,
        };
    },
});

export const recipientsForFile = internalQuery({
    args: { runId: v.id("badDebtRuns"), file: v.string() },
    handler: async (ctx, { runId, file }) =>
        await ctx.db.query("badDebtRunRecipients").withIndex("by_run_file", (q) => q.eq("runId", runId).eq("file", file)).collect(),
});

export const activeHoldIds = internalQuery({
    args: {},
    handler: async (ctx) =>
        (await ctx.db.query("badDebtHolds").withIndex("by_active", (q) => q.eq("active", true)).collect()).map((h) => h.contactId),
});

export const campaignMessages = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, { campaignId }) => {
        const msgs = await ctx.db.query("messages").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
        return msgs.map((m) => ({
            recipientId: m.recipientId,
            status: m.status,
            channel: m.channel as "email" | "whatsapp",
            recipientEmail: m.recipientEmail,
            at: new Date(m.sentAt ?? m._creationTime).toISOString(),
        }));
    },
});

// ─── Write side, for the actions ────────────────────────────────────────────

/** Open a new run, unless one is already in flight. Returns null if there is one. */
export const openRun = internalMutation({
    args: { trigger: v.string() },
    handler: async (ctx, { trigger }) => {
        const s = await ctx.db.query("badDebtSettings").first();
        if (!s) return null; // not set up on this deployment
        if (trigger === "cron" && !s.enabled) return null;
        for (const status of ACTIVE) {
            const busy = await ctx.db.query("badDebtRuns").filter((q) => q.eq(q.field("status"), status)).first();
            if (busy) return null;
        }
        const runNumber = s.lastRunNumber + 1;
        await ctx.db.patch(s._id, { lastRunNumber: runNumber });
        return await ctx.db.insert("badDebtRuns", { runNumber, status: "building", trigger, startedAt: Date.now() });
    },
});

export const saveRecipients = internalMutation({
    args: {
        runId: v.id("badDebtRuns"),
        rows: v.array(v.object({
            file: v.string(), contactId: v.string(), badDebtId: v.string(), invoiceId: v.string(), amount: v.number(),
            recipient: v.object({
                id: v.string(), email: v.optional(v.string()), phone: v.optional(v.string()), name: v.string(), variables: v.optional(v.string()),
            }),
        })),
    },
    handler: async (ctx, { runId, rows }) => {
        for (const r of rows) await ctx.db.insert("badDebtRunRecipients", { runId, ...r });
    },
});

export const saveReplies = internalMutation({
    args: {
        runId: v.id("badDebtRuns"),
        replies: v.array(v.object({ contactId: v.string(), name: v.string(), channel: v.string(), at: v.string(), text: v.string(), bucket: v.string() })),
        autoHolds: v.array(v.object({ contactId: v.string(), name: v.string(), reason: v.string() })),
    },
    handler: async (ctx, { runId, replies, autoHolds }) => {
        for (const r of replies) await ctx.db.insert("badDebtReplies", { runId, ...r });
        for (const h of autoHolds) {
            const have = await ctx.db.query("badDebtHolds").withIndex("by_contact", (q) => q.eq("contactId", h.contactId)).first();
            if (have) continue; // never overrides a reviewer's decision either way
            await ctx.db.insert("badDebtHolds", { ...h, source: "auto", active: true, updatedAt: Date.now() });
        }
    },
});

/** Mark the build finished and, unless paused, schedule the send at the end of the review window. */
export const finishBuild = internalMutation({
    args: {
        runId: v.id("badDebtRuns"),
        summary: v.any(),
        repliesSince: v.string(),
        pauseReason: v.optional(v.string()),
    },
    handler: async (ctx, { runId, summary, repliesSince, pauseReason }) => {
        const s = await settingsOrThrow(ctx);
        const now = Date.now();
        const sendAt = now + s.reviewHours * 3_600_000;
        if (pauseReason) {
            await ctx.db.patch(runId, { status: "paused", builtAt: now, summary, repliesSince, pauseReason, sendAt });
            return { sendAt: null };
        }
        const sendJobId = await ctx.scheduler.runAt(sendAt, internal.actions.badDebtRun.sendRun, { runId });
        await ctx.db.patch(runId, { status: "review", builtAt: now, summary, repliesSince, sendAt, sendJobId });
        return { sendAt };
    },
});

export const failRun = internalMutation({
    args: { runId: v.id("badDebtRuns"), error: v.string() },
    handler: async (ctx, { runId, error }) => {
        await ctx.db.patch(runId, { status: "failed", error: error.slice(0, 4000) });
    },
});

/** review → sending, atomically. False when the run was paused or cancelled meanwhile. */
export const claimSend = internalMutation({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => {
        const run = await ctx.db.get(runId);
        if (!run || run.status !== "review") return false;
        const s = await settingsOrThrow(ctx);
        if (!s.enabled) {
            await ctx.db.patch(runId, { status: "paused", pauseReason: "the weekly run is switched off in settings" });
            return false;
        }
        await ctx.db.patch(runId, { status: "sending" });
        return true;
    },
});

/**
 * Create one run campaign exactly as the wizard would for an uploaded file, as the
 * settings' actor, scheduled for `startAt`. The scheduled kickoff then seeds the
 * batches, pre-generates the invoice PDFs and sends, the same path a scheduled
 * campaign from the UI takes.
 */
export const createRunCampaign = internalMutation({
    args: {
        runId: v.id("badDebtRuns"),
        file: v.string(),
        name: v.string(),
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
        recipients: v.array(v.object({
            id: v.string(), email: v.optional(v.string()), phone: v.optional(v.string()), name: v.string(), variables: v.optional(v.string()),
        })),
        startAt: v.number(),
        // A test to the reviewer: recorded apart from the run's campaigns, so it is never folded.
        testTo: v.optional(v.string()),
    },
    handler: async (ctx, a) => {
        const s = await settingsOrThrow(ctx);
        const actor = { ...ctx, auth: { getUserIdentity: async () => ({ subject: s.actorClerkId }) } };
        const common = {
            name: a.name,
            channel: a.channel,
            recipients: a.recipients,
            columnRoles: RUN_COLUMN_ROLES,
            createDynamicsActivity: false,
            scheduledAt: a.startAt,
        };
        const campaignId: Id<"campaigns"> = await startCampaignImpl(actor, a.channel === "whatsapp"
            ? { ...common, whatsappTemplateId: s.whatsappTemplateId, whatsappVariableMappings: JSON.stringify(RUN_WHATSAPP_MAPPING) }
            : {
                ...common, subject: s.emailSubject, htmlBody: s.emailHtmlBody, fromMailbox: s.emailFromMailbox,
                emailType: "utility", fontSize: s.emailFontSize, createOpportunities: false,
            });
        await ctx.scheduler.runAt(a.startAt, internal.campaignQueue.kickoffScheduledCampaign, {
            campaignId, recipients: a.recipients, channel: a.channel,
        });
        const run = await ctx.db.get(a.runId);
        if (a.testTo) {
            await ctx.db.patch(a.runId, {
                testCampaigns: [...(run?.testCampaigns ?? []), { campaignId, channel: a.channel, to: a.testTo, at: Date.now() }],
            });
            return campaignId;
        }
        await ctx.db.patch(a.runId, {
            campaigns: [...(run?.campaigns ?? []), { file: a.file, campaignId, channel: a.channel, recipients: a.recipients.length, folded: false }],
        });
        return campaignId;
    },
});

export const markSent = internalMutation({
    args: { runId: v.id("badDebtRuns"), sendReport: v.any() },
    handler: async (ctx, { runId, sendReport }) => {
        const run = await ctx.db.get(runId);
        await ctx.db.patch(runId, { status: "sent", sentAt: Date.now(), summary: { ...(run?.summary ?? {}), send: sendReport } });
    },
});

/** Apply a fold: upsert ledger entries, add bounces, mark the campaign folded. */
export const applyFold = internalMutation({
    args: {
        runId: v.id("badDebtRuns"),
        campaignId: v.id("campaigns"),
        entries: v.array(v.object({
            badDebtId: v.string(), n: v.number(), first: v.optional(v.string()), last: v.optional(v.string()), bounced: v.boolean(), fails: v.number(),
        })),
        bounces: v.array(v.object({ contactId: v.string(), address: v.string() })),
    },
    handler: async (ctx, { runId, campaignId, entries, bounces }) => {
        const run = await ctx.db.get(runId);
        const c = run?.campaigns?.find((x) => x.campaignId === campaignId);
        if (!run || !c || c.folded) return; // folding twice would double-count
        for (const e of entries) {
            const have = await ctx.db.query("badDebtLedger").withIndex("by_bad_debt", (q) => q.eq("badDebtId", e.badDebtId)).first();
            if (have) await ctx.db.patch(have._id, e);
            else await ctx.db.insert("badDebtLedger", e);
        }
        for (const b of bounces) {
            const have = await ctx.db.query("badDebtBounces")
                .withIndex("by_contact_address", (q) => q.eq("contactId", b.contactId).eq("address", b.address)).first();
            if (!have) await ctx.db.insert("badDebtBounces", b);
        }
        await ctx.db.patch(runId, {
            campaigns: run.campaigns!.map((x) => (x.campaignId === campaignId ? { ...x, folded: true } : x)),
        });
    },
});

// ─── The review page ────────────────────────────────────────────────────────

export const dashboard = query({
    args: {},
    handler: async (ctx) => {
        if (!(await checkAdminAccess(ctx))) return null;
        const settings = await ctx.db.query("badDebtSettings").first();
        const runs = await ctx.db.query("badDebtRuns").withIndex("by_run_number").order("desc").take(8);
        const current = runs[0] ?? null;
        const replies = current
            ? await ctx.db.query("badDebtReplies").withIndex("by_run", (q) => q.eq("runId", current._id)).collect()
            : [];
        const holds = await ctx.db.query("badDebtHolds").collect();
        const holdBy = new Map(holds.map((h) => [h.contactId, h]));
        const campaignStatus: Record<string, { status: string; sent: number; failed: number; total: number }> = {};
        for (const c of current?.campaigns ?? []) {
            const doc = await ctx.db.get(c.campaignId);
            if (doc) campaignStatus[c.campaignId] = { status: doc.status, sent: doc.sentCount, failed: doc.failedCount, total: doc.totalRecipients };
        }
        return {
            settings: settings && {
                enabled: settings.enabled, reviewHours: settings.reviewHours, notifyEmails: settings.notifyEmails,
                mintTokens: settings.mintTokens, writeBackStats: settings.writeBackStats, maxChangePercent: settings.maxChangePercent,
                emailSubject: settings.emailSubject, emailFromMailbox: settings.emailFromMailbox,
            },
            runs: runs.map(({ _id, runNumber, status, startedAt, builtAt, sendAt, sentAt, pauseReason, error, trigger }) =>
                ({ _id, runNumber, status, startedAt, builtAt, sendAt, sentAt, pauseReason, error, trigger })),
            current: current && { ...current, sendJobId: undefined },
            campaignStatus,
            replies: replies
                .sort((a, b) => (a.at < b.at ? 1 : -1))
                .map((r) => ({ ...r, hold: holdBy.get(r.contactId) ?? null })),
            holds: holds.filter((h) => h.active).sort((a, b) => b.updatedAt - a.updatedAt),
        };
    },
});

export const setHold = mutation({
    args: { contactId: v.string(), name: v.string(), hold: v.boolean(), reason: v.optional(v.string()) },
    handler: async (ctx, a) => {
        const who = await requireAdmin(ctx);
        const contactId = a.contactId.toLowerCase();
        const have = await ctx.db.query("badDebtHolds").withIndex("by_contact", (q) => q.eq("contactId", contactId)).first();
        const patch = {
            active: a.hold, source: "reviewer", updatedAt: Date.now(), updatedBy: who.email ?? who.subject,
            reason: a.reason ?? (a.hold ? "held by reviewer" : "released by reviewer"),
        };
        if (have) await ctx.db.patch(have._id, patch);
        else await ctx.db.insert("badDebtHolds", { contactId, name: a.name, ...patch });
    },
});

export const pauseRun = mutation({
    args: { runId: v.id("badDebtRuns"), reason: v.optional(v.string()) },
    handler: async (ctx, { runId, reason }) => {
        const who = await requireAdmin(ctx);
        const run = await ctx.db.get(runId);
        if (!run || run.status !== "review") throw new Error(`Only a run in review can be paused (this one is ${run?.status})`);
        if (run.sendJobId) await ctx.scheduler.cancel(run.sendJobId);
        await ctx.db.patch(runId, { status: "paused", pauseReason: reason ?? `paused by ${who.email ?? who.subject}`, sendJobId: undefined });
    },
});

/** Back into review. The send goes at the original time, or in 10 minutes if that has passed. */
export const resumeRun = mutation({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => {
        await requireAdmin(ctx);
        const run = await ctx.db.get(runId);
        if (!run || run.status !== "paused" || !run.builtAt) throw new Error("Only a built, paused run can be resumed");
        const sendAt = Math.max(run.sendAt ?? 0, Date.now() + 10 * 60_000);
        const sendJobId = await ctx.scheduler.runAt(sendAt, internal.actions.badDebtRun.sendRun, { runId });
        await ctx.db.patch(runId, { status: "review", pauseReason: undefined, sendAt, sendJobId });
    },
});

export const sendNow = mutation({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => {
        await requireAdmin(ctx);
        const run = await ctx.db.get(runId);
        if (!run || run.status !== "review") throw new Error("Only a run in review can be sent");
        if (run.sendJobId) await ctx.scheduler.cancel(run.sendJobId);
        const sendJobId = await ctx.scheduler.runAfter(0, internal.actions.badDebtRun.sendRun, { runId });
        await ctx.db.patch(runId, { sendAt: Date.now(), sendJobId });
    },
});

export const cancelRun = mutation({
    args: { runId: v.id("badDebtRuns") },
    handler: async (ctx, { runId }) => {
        await requireAdmin(ctx);
        const run = await ctx.db.get(runId);
        if (!run || !["review", "paused", "failed", "building"].includes(run.status)) throw new Error(`A ${run?.status} run cannot be cancelled`);
        if (run.sendJobId) await ctx.scheduler.cancel(run.sendJobId);
        await ctx.db.patch(runId, { status: "cancelled", sendJobId: undefined });
    },
});

/**
 * Send the run's first WhatsApp row and first email row to the reviewer instead of
 * the client: the real template, amount, invoice PDF and Pay-now link, with the
 * consultant CC removed. Does not change the run's state.
 */
export const sendTest = mutation({
    args: { runId: v.id("badDebtRuns"), phone: v.string(), email: v.string() },
    handler: async (ctx, a) => {
        await requireAdmin(ctx);
        const run = await ctx.db.get(a.runId);
        if (!run || !["review", "paused"].includes(run.status)) throw new Error("Only a built run in review or paused can be tested");
        await ctx.scheduler.runAfter(0, internal.actions.badDebtRun.sendTestRun, a);
    },
});

/** Build a run now instead of waiting for Monday. It still waits out the review window. */
export const buildNow = mutation({
    args: {},
    handler: async (ctx) => {
        const who = await requireAdmin(ctx);
        await ctx.scheduler.runAfter(0, internal.actions.badDebtRun.buildRun, { trigger: who.subject });
    },
});

export const updateSettings = mutation({
    args: {
        enabled: v.optional(v.boolean()),
        reviewHours: v.optional(v.number()),
        notifyEmails: v.optional(v.array(v.string())),
        mintTokens: v.optional(v.boolean()),
        writeBackStats: v.optional(v.boolean()),
    },
    handler: async (ctx, a) => {
        await requireAdmin(ctx);
        const s = await settingsOrThrow(ctx);
        const patch = Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined));
        if (patch.reviewHours !== undefined && (patch.reviewHours as number) < 1) throw new Error("The review window must be at least an hour");
        await ctx.db.patch(s._id, patch);
    },
});

/**
 * One-off: create the settings row. Run from the dashboard or CLI, e.g.
 *   npx convex run badDebtRuns:setup '{"actorClerkId":"user_…","whatsappTemplateId":"jd7…",…}'
 * Starts DISABLED and read-only (no minting, no write-back).
 */
export const setup = internalMutation({
    args: {
        actorClerkId: v.string(),
        whatsappTemplateId: v.id("whatsappTemplates"),
        emailHtmlBody: v.string(),
        notifyEmails: v.array(v.string()),
        lastRunNumber: v.number(),
        baselinePeople: v.optional(v.number()),
    },
    handler: async (ctx, a) => {
        if (await ctx.db.query("badDebtSettings").first()) throw new Error("already set up");
        await ctx.db.insert("badDebtSettings", {
            ...a,
            enabled: false,
            emailSubject: "Outstanding Invoice",
            emailFromMailbox: "accounts@ttt-tax.co.za",
            emailFontSize: "18px",
            reviewHours: 3,
            maxChangePercent: 25,
            mintTokens: false,
            writeBackStats: false,
        });
    },
});

/** CLI twin of {@link updateSettings} (`npx convex run` has no signed-in user). */
export const updateSettingsInternal = internalMutation({
    args: {
        enabled: v.optional(v.boolean()),
        reviewHours: v.optional(v.number()),
        notifyEmails: v.optional(v.array(v.string())),
        mintTokens: v.optional(v.boolean()),
        writeBackStats: v.optional(v.boolean()),
        emailHtmlBody: v.optional(v.string()),
        maxChangePercent: v.optional(v.number()),
    },
    handler: async (ctx, a) => {
        const s = await settingsOrThrow(ctx);
        await ctx.db.patch(s._id, Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)));
    },
});
