/**
 * At-most-once for WhatsApp + personalised via the SHARED send seam (PRD #55, #61).
 *
 * The email path's at-most-once guarantee is owned in one seam — the eligibility
 * rule (#56) + the idempotent `attempted` marker (#58) — and this proves the other
 * two channels now inherit it rather than re-implementing per-adapter dedup.
 *
 * Each test wires the REAL seam pieces around the REAL adapter and fakes only the
 * channel's provider boundary:
 *   - `eligibleRecipients` (the #56 rule) computes who may send
 *   - `markAttemptedBatchImpl` (the #58 idempotent upsert) records the marker
 *   - `whatsappSender` / `personalisedSender` run for real
 * A stateful in-memory `messages` store stands in for the DB, and `runOnce`
 * mirrors the driver's per-batch steps exactly: compute eligible → build the
 * driver-owned `markAttempted` closure → run the adapter → settle emitted results
 * (success→`sent`, failure→`failed`) the way `updateStatusBatch` would.
 *
 * The post-crash precondition — one recipient already settled `failed` from an
 * ambiguous provider response, one still `pending` (seed row, never handed to a
 * provider) — is set up directly, exactly as the headline email regression (#62)
 * does. The assertion is the seam's whole point: the recovery re-run resends the
 * already-handled recipient ZERO times while completing the genuinely-unfinished
 * one, with no duplicate rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";

const boundary = vi.hoisted(() => ({
    // WhatsApp
    sendTemplateWithRetry: vi.fn(),
    fetchContactFieldsByIds: vi.fn(),
    notifyTinaOfOutboundTemplate: vi.fn(),
    // Personalised
    dynamicsRequest: vi.fn(),
    generatePersonalisedCopy: vi.fn(),
    sendEmail: vi.fn(),
}));

vi.mock("../lib/whatsapp", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return {
        ...actual,
        getMetaWhatsAppConfig: () => ({
            phoneNumberId: "pnid",
            accessToken: "token",
            apiVersion: "v20.0",
            maxSendPerSecond: 1000,
            maxConcurrent: 1,
        }),
        sendTemplateWithRetry: boundary.sendTemplateWithRetry,
    };
});
vi.mock("../lib/dynamics_util", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, fetchContactFieldsByIds: boundary.fetchContactFieldsByIds };
});
vi.mock("../lib/notifyTina", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, notifyTinaOfOutboundTemplate: boundary.notifyTinaOfOutboundTemplate };
});
vi.mock("../lib/dynamics_auth", () => ({ dynamicsRequest: boundary.dynamicsRequest }));
vi.mock("../lib/claude", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, generatePersonalisedCopy: boundary.generatePersonalisedCopy };
});
vi.mock("../lib/graph_client", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, sendEmail: boundary.sendEmail };
});

import { whatsappSender, personalisedSender } from "../channelSenders";
import { eligibleRecipients } from "../lib/sendEligibility";
import { markAttemptedBatchImpl } from "../messages";
import type { ChannelSender, DriverBatch } from "../lib/channelSend";

// ---------------------------------------------------------------------------
// Stateful in-memory `messages` store + the by_campaign_recipient index shape
// markAttemptedBatchImpl and the eligibility query rely on.
// ---------------------------------------------------------------------------
function makeStore() {
    const rows: Array<Record<string, any>> = [];
    let seq = 0;
    const db = {
        insert: async (table: string, doc: Record<string, any>) => {
            const _id = `${table}:${seq++}`;
            rows.push({ _id, ...doc });
            return _id;
        },
        patch: async (id: string, fields: Record<string, any>) => {
            const r = rows.find((x) => x._id === id);
            if (r) Object.assign(r, fields);
        },
        query: (_table: string) => ({
            withIndex: (_index: string, fn?: (q: any) => any) => {
                const c: Record<string, unknown> = {};
                const q = { eq: (f: string, v: unknown) => ((c[f] = v), q) };
                if (fn) fn(q);
                const matched = rows.filter((r) =>
                    Object.entries(c).every(([k, v]) => r[k] === v)
                );
                return { first: async () => matched[0] ?? null, collect: async () => matched.slice() };
            },
        }),
    };
    return { rows, db };
}

/** Adapter-facing ctx: the adapter's own runQuery/runMutation/runAction/scheduler.
 *  The seam's markAttempted is a driver-owned closure passed separately, so it
 *  never routes through here. */
function makeAdapterCtx(runQueryImpl: (name: string, args: any) => any) {
    return {
        runQuery: vi.fn(async (ref: unknown, args: any) => runQueryImpl(getFunctionName(ref as any), args)),
        runMutation: vi.fn(async () => undefined),
        runAction: vi.fn(async () => undefined),
        scheduler: { runAfter: vi.fn(async () => undefined) },
    } as any;
}

/** One faithful pass of the driver's per-batch control flow over a real adapter. */
async function runOnce(opts: {
    store: ReturnType<typeof makeStore>;
    campaignId: string;
    campaign: any;
    channel: "whatsapp" | "personalised";
    batch: DriverBatch;
    sender: ChannelSender;
    runQueryImpl: (name: string, args: any) => any;
}) {
    const { store, campaignId, campaign, channel, batch, sender, runQueryImpl } = opts;

    const rowFor = (rid: string) =>
        store.db
            .query("messages")
            .withIndex("by_campaign_recipient", (q: any) =>
                q.eq("campaignId", campaignId).eq("recipientId", rid)
            )
            .first();

    // 1. Compute eligible via the REAL rule from the store's current rows.
    const existing: Array<{ recipientId: string; status: string }> = [];
    for (const r of batch.recipients) {
        const msg = await rowFor(r.id);
        if (msg) existing.push({ recipientId: r.id, status: msg.status });
    }
    const eligible = eligibleRecipients(existing, batch.recipients);

    // 2. Driver-owned markAttempted closure → the REAL idempotent upsert.
    const recipientById = new Map(batch.recipients.map((r) => [r.id, r]));
    const markAttempted = async (ids: string[]) => {
        if (ids.length === 0) return;
        await markAttemptedBatchImpl(
            { db: store.db },
            {
                campaignId: campaignId as any,
                channel,
                recipients: ids.map((id) => {
                    const r = recipientById.get(id);
                    return {
                        recipientId: id,
                        recipientEmail: r?.email,
                        recipientPhone: r?.phone,
                        recipientName: r?.name ?? "",
                    };
                }),
            }
        );
    };

    // 3. Buffer emit and settle each result to the store, as updateStatusBatch does.
    const emitted: Array<{ recipientId: string; success: boolean }> = [];
    const emit = async (results: any[]) => {
        for (const res of results) {
            emitted.push(res);
            const msg = await rowFor(res.recipientId);
            if (msg) {
                await store.db.patch(msg._id, {
                    status: res.success ? "sent" : "failed",
                    errorMessage: res.error,
                    externalMessageId: res.externalMessageId,
                });
            }
        }
    };

    // 4. Run the REAL adapter through the seam.
    const ctx = makeAdapterCtx(runQueryImpl);
    await sender.sendBatch(ctx, campaign, batch, emit, eligible, markAttempted);

    return { eligible, emitted };
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVEX_SITE_URL;
});

describe("WhatsApp at-most-once via the shared seam (#61)", () => {
    it("recovery re-run resends an ambiguously-failed recipient ZERO times and completes the unfinished one", async () => {
        const store = makeStore();
        const campaignId = "c-wa";
        const campaign = { _id: campaignId, status: "processing", whatsappTemplateId: "t1", createDynamicsActivity: false };
        const batch: DriverBatch = {
            _id: "wb1" as any,
            recipients: [
                { id: "A", phone: "+27821111111", name: "Alice" },
                { id: "B", phone: "+27822222222", name: "Bob" },
            ],
        };
        // Post-crash: A already settled `failed` (ambiguous Meta response that
        // actually delivered); B still `pending` (seed row, never handed to Meta).
        await store.db.insert("messages", { campaignId, recipientId: "A", recipientName: "Alice", status: "failed", channel: "whatsapp" });
        await store.db.insert("messages", { campaignId, recipientId: "B", recipientName: "Bob", status: "pending", channel: "whatsapp" });

        boundary.fetchContactFieldsByIds.mockResolvedValue(new Map());
        const sentTo: string[] = [];
        boundary.sendTemplateWithRetry.mockImplementation(async (_cfg: any, body: any) => {
            sentTo.push(body.to);
            return { status: "sent", wamid: "wamid.new", attempts: 1, latencyMs: 1 };
        });

        const runQueryImpl = (name: string) => {
            if (name === "campaignBatches:getWhatsAppTemplate") {
                return { _id: "t1", name: "promo", language: "en", variables: [], body: "Hi", headerType: undefined };
            }
            return undefined;
        };

        const { eligible, emitted } = await runOnce({ store, campaignId, campaign, channel: "whatsapp", batch, sender: whatsappSender, runQueryImpl });

        // The real eligibility rule excludes the already-`failed` A; only B sends.
        expect(eligible.map((r) => r.id)).toEqual(["B"]);
        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        expect(sentTo).toEqual(["27822222222"]);
        expect(emitted.map((e) => e.recipientId)).toEqual(["B"]);

        // A untouched & not duplicated; B completed. One row per recipient.
        const rows = store.rows.filter((r) => r.campaignId === campaignId);
        const byId = Object.fromEntries(rows.map((r) => [r.recipientId, r]));
        expect(byId.A.status).toBe("failed");
        expect(byId.B.status).toBe("sent");
        expect(rows.filter((r) => r.recipientId === "A")).toHaveLength(1);
        expect(rows.filter((r) => r.recipientId === "B")).toHaveLength(1);
    });
});

describe("Personalised at-most-once via the shared seam (#61)", () => {
    it("recovery re-run resends an ambiguously-failed recipient ZERO times and completes the unfinished one", async () => {
        const store = makeStore();
        const campaignId = "c-pers";
        const campaign = {
            _id: campaignId,
            status: "processing",
            name: "RA Plan",
            subject: "{firstName}, your plan",
            fromMailbox: "sender@ttt.test",
            createOpportunities: false,
        };
        const batch: DriverBatch = {
            _id: "pb1" as any,
            recipients: [
                { id: "A", email: "alice@x.test", name: "Alice Jones" },
                { id: "B", email: "bob@x.test", name: "Bob Lee" },
            ],
        };
        // Post-crash: A already `failed`; B still `pending`.
        await store.db.insert("messages", { campaignId, recipientId: "A", recipientEmail: "alice@x.test", recipientName: "Alice Jones", status: "failed", channel: "personalised" });
        await store.db.insert("messages", { campaignId, recipientId: "B", recipientEmail: "bob@x.test", recipientName: "Bob Lee", status: "pending", channel: "personalised" });

        const ita34 = {
            riivo_yearofassessment: 2024,
            riivo_income: 500000,
            riivo_taxableincomeassessedloss: 500000,
            riivo_retirementannuityfundcontributions: 0,
            riivo_retirementfundcontributions: 0,
            riivo_providendfundcontributions: 0,
            riivo_medicalschemefeestaxcredit: 0,
            riivo_medicalrebatebelow65withnodisability: 0,
            riivo_dateofassessment: null,
            riivo_referencenumber: null,
        };
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) return { value: [ita34] };
            if (path.includes("riivo_irp5s")) return { value: [] };
            if (path.includes("contacts(")) return { fullname: "Bob Lee", firstname: "Bob", ttt_idnumber: null, riivo_age: 40 };
            return { value: [] };
        });
        boundary.generatePersonalisedCopy.mockResolvedValue({ greeting: "Hi Bob", closingText: "Regards" });
        const sentTo: string[] = [];
        boundary.sendEmail.mockImplementation(async (msg: any) => {
            sentTo.push(msg.toRecipients[0].email);
            return { success: true };
        });

        const runQueryImpl = (name: string) => {
            if (name === "campaignBatches:getCampaignContent") return { aiSystemPrompt: "sys", aiPrompt: "p" };
            return undefined;
        };

        const { eligible, emitted } = await runOnce({ store, campaignId, campaign, channel: "personalised", batch, sender: personalisedSender, runQueryImpl });

        // The real eligibility rule excludes the already-`failed` A; only B sends.
        expect(eligible.map((r) => r.id)).toEqual(["B"]);
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1);
        expect(sentTo).toEqual(["bob@x.test"]);
        expect(emitted.map((e) => e.recipientId)).toEqual(["B"]);

        // A untouched & not duplicated; B completed. One row per recipient.
        const rows = store.rows.filter((r) => r.campaignId === campaignId);
        const byId = Object.fromEntries(rows.map((r) => [r.recipientId, r]));
        expect(byId.A.status).toBe("failed");
        expect(byId.B.status).toBe("sent");
        expect(rows.filter((r) => r.recipientId === "A")).toHaveLength(1);
        expect(rows.filter((r) => r.recipientId === "B")).toHaveLength(1);
    }, 20000);
});
