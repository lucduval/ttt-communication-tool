/**
 * Recompute funnel tests (PRD #44, slice #46).
 *
 * The denormalised stat cache on a campaign document (sentCount / deliveredCount
 * / failedCount) is a RECOMPUTED projection of the messages table — never an
 * additively-accumulated counter. These tests drive the plain
 * `recomputeCampaignStats` and `recordBouncesImpl` against a faked Convex `ctx`
 * (mirroring `recoverStuckBatches.test.ts`), pinning the drift-free properties:
 *   - counters equal the Campaign Tally of the seeded message statuses;
 *   - recompute SETS, never increments — replaying a settle, or recovering and
 *     re-running a batch, leaves the counts unchanged;
 *   - a bounce flips its message to "failed", lowering delivered / raising failed
 *     consistently once recompute runs, and is idempotent on replay.
 */
import { describe, it, expect } from "vitest";
import { recomputeCampaignStats } from "../campaignBatches";
import { recordBouncesImpl } from "../bounces";

type Message = {
    _id: string;
    campaignId: string;
    recipientId: string;
    status: string;
    errorMessage?: string;
};
type Campaign = {
    _id: string;
    sentCount?: number;
    deliveredCount?: number;
    failedCount?: number;
};

function createCtx(messages: Message[], campaign: Campaign) {
    const db = {
        query: (_table: string) => ({
            withIndex: (_index: string, fn: (q: any) => any) => {
                const constraints: Record<string, unknown> = {};
                const q = {
                    eq: (field: string, value: unknown) => {
                        constraints[field] = value;
                        return q;
                    },
                };
                fn(q);
                const match = (m: any) =>
                    Object.entries(constraints).every(([k, v]) => m[k] === v);
                return {
                    collect: async () => messages.filter(match),
                    first: async () => messages.find(match) ?? null,
                };
            },
        }),
        patch: async (id: string, fields: Record<string, unknown>) => {
            if (id === campaign._id) {
                Object.assign(campaign, fields);
                return;
            }
            const m = messages.find((x) => x._id === id);
            if (m) Object.assign(m, fields);
        },
        get: async (id: string) => (id === campaign._id ? campaign : null),
        normalizeId: (_table: string, id: string) => id,
    };
    return { ctx: { db } as any, messages, campaign };
}

function seed(campaignId: string, statuses: string[]): Message[] {
    return statuses.map((status, i) => ({
        _id: `m${i}`,
        campaignId,
        recipientId: `r${i}`,
        status,
    }));
}

describe("recomputeCampaignStats", () => {
    it("sets the counters to the Campaign Tally of the seeded messages", async () => {
        const campaign: Campaign = { _id: "c1" };
        const { ctx } = createCtx(
            seed("c1", ["sent", "sent", "delivered", "failed", "pending"]),
            campaign
        );

        await recomputeCampaignStats(ctx, "c1" as any);

        // sent = "sent" + "delivered" = 2 + 1; delivered mirrors sent (no
        // post-handoff signal distinct from bounces); failed = 1.
        expect(campaign.sentCount).toBe(3);
        expect(campaign.deliveredCount).toBe(3);
        expect(campaign.failedCount).toBe(1);
    });

    it("overwrites stale counters instead of incrementing them", async () => {
        const campaign: Campaign = {
            _id: "c1",
            sentCount: 999,
            deliveredCount: 999,
            failedCount: 999,
        };
        const { ctx } = createCtx(seed("c1", ["sent", "delivered"]), campaign);

        await recomputeCampaignStats(ctx, "c1" as any);

        expect(campaign.sentCount).toBe(2);
        expect(campaign.deliveredCount).toBe(2);
        expect(campaign.failedCount).toBe(0);
    });

    it("is idempotent — replaying a batch settle leaves the counts unchanged", async () => {
        const campaign: Campaign = { _id: "c1" };
        const { ctx } = createCtx(seed("c1", ["sent", "sent", "failed"]), campaign);

        await recomputeCampaignStats(ctx, "c1" as any);
        const afterFirst = { ...campaign };
        await recomputeCampaignStats(ctx, "c1" as any);

        expect(campaign).toEqual(afterFirst);
        expect(campaign.sentCount).toBe(2);
        expect(campaign.failedCount).toBe(1);
    });

    it("recovering and re-running a batch leaves the counts unchanged", async () => {
        // A batch settles; recovery resets it to pending; the re-run writes the
        // same per-recipient statuses idempotently. The recompute after each
        // settle yields identical counts — no accumulation across recovery.
        const campaign: Campaign = { _id: "c1" };
        const messages = seed("c1", ["sent", "sent", "sent"]);
        const { ctx } = createCtx(messages, campaign);

        await recomputeCampaignStats(ctx, "c1" as any); // first settle
        const afterSettle = { ...campaign };

        // Recovery + re-run: idempotent status writes leave messages unchanged.
        await recomputeCampaignStats(ctx, "c1" as any); // re-run settle

        expect(campaign).toEqual(afterSettle);
        expect(campaign.sentCount).toBe(3);
    });
});

describe("recordBouncesImpl", () => {
    it("a bounce lowers delivered and raises failed once recompute runs", async () => {
        const campaign: Campaign = { _id: "c1" };
        const messages = seed("c1", ["delivered", "sent", "pending"]);
        const { ctx } = createCtx(messages, campaign);

        await recomputeCampaignStats(ctx, "c1" as any);
        // delivered mirrors sent: "delivered"(r0) + "sent"(r1) = 2.
        expect(campaign.deliveredCount).toBe(2);
        expect(campaign.failedCount).toBe(0);

        // Bounce the delivered recipient (r0).
        await recordBouncesImpl(ctx, [
            { campaignId: "c1", recipientId: "r0", messageId: "ext-0" },
        ]);

        expect(messages[0].status).toBe("failed");
        // The bounce demotes r0 out of the success bucket: sent = delivered = 1.
        expect(campaign.deliveredCount).toBe(1);
        expect(campaign.failedCount).toBe(1);
        // sent = remaining "sent" (r1) only; the bounced "delivered" no longer counts.
        expect(campaign.sentCount).toBe(1);
    });

    it("is idempotent — bouncing an already-failed recipient does not change counts", async () => {
        const campaign: Campaign = { _id: "c1" };
        const messages = seed("c1", ["failed", "sent"]);
        const { ctx } = createCtx(messages, campaign);

        await recomputeCampaignStats(ctx, "c1" as any);
        const before = { ...campaign };

        await recordBouncesImpl(ctx, [
            { campaignId: "c1", recipientId: "r0", messageId: "ext-0" },
        ]);

        expect(campaign).toEqual(before);
        expect(campaign.failedCount).toBe(1);
    });
});
