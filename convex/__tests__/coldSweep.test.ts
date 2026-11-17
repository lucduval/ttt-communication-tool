/**
 * Cold-sweep queue tests (Convex insight: `listUnengagedOpportunityMessages`
 * nearing/exceeding the 32k documents-read limit).
 *
 * The sweep used to walk the whole `by_status` "sent" range and post-`filter()`
 * for "has an opportunity AND sent > 30 days ago" — a filter Convex applies
 * AFTER reading, so `.take(100)` bounded the RESULT, not the READ. With tens of
 * thousands of sent messages and only a sliver carrying an opportunity, the
 * transaction read the table until it hit the ceiling and the cron just failed.
 *
 * The fix is a durable per-row queue marker (`messages.coldSweep`) written only
 * where an opportunity is linked, plus the `by_cold_sweep` index, so the whole
 * predicate resolves as an index range. These tests drive the plain
 * `listColdSweepPage` against a faked Convex `ctx` (mirroring
 * recomputeCampaignStats.test.ts) and pin the two properties that matter:
 *   - reads are bounded by `limit`, whatever else is in the table;
 *   - every row read comes back with a verdict, so the caller can retire the
 *     page and the queue drains instead of re-reading the same head daily.
 */
import { describe, it, expect } from "vitest";
import { listColdSweepPage } from "../messages";

type Row = Record<string, any>;

/**
 * Faked `ctx.db` that honours index ranges the way Convex does — the `eq`/`lt`
 * constraints select rows BEFORE anything is read, and `take` caps the page — so
 * a read count taken here is the read count the deployment would charge.
 * A missing `sentAt` sorts before every number, as it does in a real index.
 */
function createCtx(tables: { messages: Row[]; opens?: Row[]; clicks?: Row[] }) {
    const reads: Record<string, number> = { messages: 0, opens: 0, clicks: 0 };

    const db = {
        query: (table: string) => ({
            withIndex: (index: string, fn: (q: any) => any) => {
                const eqs: Record<string, unknown> = {};
                const ranges: { field: string; value: any }[] = [];
                const q: any = {
                    eq: (field: string, value: unknown) => {
                        eqs[field] = value;
                        return q;
                    },
                    lt: (field: string, value: any) => {
                        ranges.push({ field, value });
                        return q;
                    },
                };
                fn(q);

                const rows: Row[] = (tables as any)[table] ?? [];
                let matched = rows.filter(
                    (r) =>
                        Object.entries(eqs).every(([k, v]) => r[k] === v) &&
                        ranges.every(
                            ({ field, value }) => r[field] === undefined || r[field] < value
                        )
                );
                if (index === "by_cold_sweep") {
                    matched = [...matched].sort(
                        (a, b) => (a.sentAt ?? -Infinity) - (b.sentAt ?? -Infinity)
                    );
                }

                return {
                    take: async (n: number) => {
                        const page = matched.slice(0, n);
                        reads[table] += page.length;
                        return page;
                    },
                    first: async () => {
                        const hit = matched[0] ?? null;
                        if (hit) reads[table] += 1;
                        return hit;
                    },
                };
            },
        }),
    };

    return { ctx: { db } as any, reads };
}

const CUTOFF = 30_000;

function sentMessage(i: number, overrides: Row = {}): Row {
    return {
        _id: `m${i}`,
        campaignId: "c1",
        recipientId: `r${i}`,
        status: "sent",
        sentAt: 1_000 + i,
        opportunityId: `opp${i}`,
        coldSweep: "pending",
        ...overrides,
    };
}

describe("listColdSweepPage", () => {
    it("reads at most `limit` messages however many sent rows surround them", async () => {
        // 5 queued candidates buried in 5,000 sent messages with no opportunity —
        // the shape that blew the documents-read limit.
        const noise = Array.from({ length: 5_000 }, (_, i) => ({
            _id: `n${i}`,
            campaignId: "c1",
            recipientId: `n${i}`,
            status: "sent",
            sentAt: 500 + i,
            // no opportunityId, so `setOpportunityId` never marked it
            coldSweep: undefined,
        }));
        const queued = Array.from({ length: 5 }, (_, i) => sentMessage(i));

        const { ctx, reads } = createCtx({ messages: [...noise, ...queued] });

        const verdicts = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 100 });

        expect(verdicts.map((v) => v.messageId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
        expect(verdicts.every((v) => v.markCold)).toBe(true);
        expect(reads.messages).toBe(5); // not 5,005
    });

    it("caps the page at `limit`, oldest send first", async () => {
        const messages = Array.from({ length: 250 }, (_, i) => sentMessage(i));
        const { ctx, reads } = createCtx({ messages });

        const verdicts = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 200 });

        expect(verdicts).toHaveLength(200);
        expect(verdicts[0].messageId).toBe("m0");
        expect(reads.messages).toBe(200);
        // Two engagement probes per candidate at worst — bounded by `limit` too.
        expect(reads.opens + reads.clicks).toBeLessThanOrEqual(400);
    });

    it("leaves rows sent after the cutoff, and rows already swept, in place", async () => {
        const messages = [
            sentMessage(1, { sentAt: CUTOFF + 1 }), // too recent to judge
            sentMessage(2, { coldSweep: "swept" }), // already evaluated
            sentMessage(3, { coldSweep: undefined }), // never had an opportunity linked
            sentMessage(4), // the only due row
        ];
        const { ctx, reads } = createCtx({ messages });

        const verdicts = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 100 });

        expect(verdicts).toEqual([{ messageId: "m4", opportunityId: "opp4", markCold: true }]);
        expect(reads.messages).toBe(1);
    });

    it("returns an engaged recipient with markCold false so it still leaves the queue", async () => {
        const messages = [sentMessage(1), sentMessage(2), sentMessage(3)];
        const { ctx } = createCtx({
            messages,
            opens: [{ campaignId: "c1", recipientId: "r1", openedAt: 1 }],
            clicks: [{ campaignId: "c1", recipientId: "r2", url: "u", clickedAt: 1 }],
        });

        const verdicts = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 100 });

        expect(verdicts).toEqual([
            { messageId: "m1", opportunityId: "opp1", markCold: false },
            { messageId: "m2", opportunityId: "opp2", markCold: false },
            { messageId: "m3", opportunityId: "opp3", markCold: true },
        ]);
    });

    it("judges a row that left `sent` — or never got a send time — as not Cold", async () => {
        const messages = [
            sentMessage(1, { status: "failed" }), // bounced after the send settled
            sentMessage(2, { sentAt: undefined }), // sorts to the head of the index
        ];
        const { ctx, reads } = createCtx({ messages });

        const verdicts = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 100 });

        expect(verdicts).toEqual([
            { messageId: "m2", markCold: false },
            { messageId: "m1", markCold: false },
        ]);
        // No engagement probes for an ineligible row, and it is still reported so
        // the caller retires it rather than letting it clog the queue head.
        expect(reads.opens + reads.clicks).toBe(0);
    });

    it("drains: a retired page is not read again on the next pass", async () => {
        const messages = Array.from({ length: 3 }, (_, i) => sentMessage(i));
        const { ctx, reads } = createCtx({ messages });

        const first = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 2 });
        // What `markColdSweepSwept` does once the cron has acted on the page.
        for (const v of first) {
            messages.find((m) => m._id === v.messageId)!.coldSweep = "swept";
        }
        const second = await listColdSweepPage(ctx, { sentBefore: CUTOFF, limit: 2 });

        expect(first.map((v) => v.messageId)).toEqual(["m0", "m1"]);
        expect(second.map((v) => v.messageId)).toEqual(["m2"]);
        expect(reads.messages).toBe(3); // each message read once across both passes
    });
});
