/**
 * `markAttemptedBatch` upsert tests (PRD #55, slice #58).
 *
 * `markAttemptedBatch` is the driver-owned "handed to Graph" marker write — the
 * durable `attempted` row the email path previously lacked. It is the idempotent
 * upsert keyed by (campaignId, recipientId) that makes a recovery re-run a no-op.
 * These drive the plain `markAttemptedBatchImpl` against a faked Convex `ctx`
 * (mirroring recomputeCampaignStats.test.ts), pinning the upsert truth table:
 *   - no row            → insert a fresh `attempted` row
 *   - existing `pending`→ advance to `attempted` (forward, not a regression)
 *   - settled / already-`attempted` → no-op (no duplicate row, no status regression)
 *   - re-invoking is idempotent — the headline "recovery sends zero duplicates" bit.
 */
import { describe, it, expect } from "vitest";
import { markAttemptedBatchImpl } from "../messages";

type Message = {
    _id: string;
    campaignId: string;
    recipientId: string;
    recipientName: string;
    recipientEmail?: string;
    recipientPhone?: string;
    status: string;
    channel: string;
};

function createCtx(messages: Message[]) {
    let seq = messages.length;
    const inserted: Message[] = [];
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
                    first: async () => messages.find(match) ?? null,
                };
            },
        }),
        insert: async (_table: string, doc: Record<string, unknown>) => {
            const row = { _id: `m${seq++}`, ...(doc as any) } as Message;
            messages.push(row);
            inserted.push(row);
            return row._id;
        },
        patch: async (id: string, fields: Record<string, unknown>) => {
            const m = messages.find((x) => x._id === id);
            if (m) Object.assign(m, fields);
        },
    };
    return { ctx: { db } as any, messages, inserted };
}

const recip = (recipientId: string) => ({
    recipientId,
    recipientEmail: `${recipientId}@example.com`,
    recipientName: recipientId.toUpperCase(),
});

describe("markAttemptedBatchImpl (idempotent upsert)", () => {
    it("inserts a fresh `attempted` row for a recipient with no existing row", async () => {
        const { ctx, messages } = createCtx([]);

        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1")],
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            campaignId: "c1",
            recipientId: "r1",
            recipientEmail: "r1@example.com",
            recipientName: "R1",
            status: "attempted",
            channel: "email",
        });
    });

    it("advances an existing `pending` row to `attempted` without inserting", async () => {
        const { ctx, messages, inserted } = createCtx([
            {
                _id: "m0",
                campaignId: "c1",
                recipientId: "r1",
                recipientName: "R1",
                status: "pending",
                channel: "email",
            },
        ]);

        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1")],
        });

        expect(inserted).toHaveLength(0);
        expect(messages).toHaveLength(1);
        expect(messages[0].status).toBe("attempted");
    });

    it("never regresses a settled `sent`/`delivered`/`failed` row (no-op)", async () => {
        for (const settled of ["sent", "delivered", "failed"]) {
            const { ctx, messages, inserted } = createCtx([
                {
                    _id: "m0",
                    campaignId: "c1",
                    recipientId: "r1",
                    recipientName: "R1",
                    status: settled,
                    channel: "email",
                },
            ]);

            await markAttemptedBatchImpl(ctx, {
                campaignId: "c1" as any,
                channel: "email",
                recipients: [recip("r1")],
            });

            expect(inserted).toHaveLength(0);
            expect(messages).toHaveLength(1);
            expect(messages[0].status).toBe(settled);
        }
    });

    it("is a no-op when re-marking an already-`attempted` recipient (idempotent)", async () => {
        const { ctx, messages, inserted } = createCtx([
            {
                _id: "m0",
                campaignId: "c1",
                recipientId: "r1",
                recipientName: "R1",
                status: "attempted",
                channel: "email",
            },
        ]);

        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1")],
        });

        expect(inserted).toHaveLength(0);
        expect(messages).toHaveLength(1);
        expect(messages[0].status).toBe("attempted");
    });

    it("re-running the same mark yields a single row, still `attempted` (recovery = zero duplicates)", async () => {
        const { ctx, messages } = createCtx([]);

        // First run marks the chunk; a crash-recovery re-run re-marks the same ids.
        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1"), recip("r2")],
        });
        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1"), recip("r2")],
        });

        expect(messages).toHaveLength(2);
        expect(messages.every((m) => m.status === "attempted")).toBe(true);
    });

    it("scopes the upsert per (campaignId, recipientId) — same recipient, other campaign is independent", async () => {
        const { ctx, messages } = createCtx([
            {
                _id: "m0",
                campaignId: "cOTHER",
                recipientId: "r1",
                recipientName: "R1",
                status: "sent",
                channel: "email",
            },
        ]);

        await markAttemptedBatchImpl(ctx, {
            campaignId: "c1" as any,
            channel: "email",
            recipients: [recip("r1")],
        });

        // A new row for c1 is inserted; the cOTHER row is untouched.
        expect(messages).toHaveLength(2);
        const c1Row = messages.find((m) => m.campaignId === "c1");
        expect(c1Row?.status).toBe("attempted");
        expect(messages.find((m) => m.campaignId === "cOTHER")?.status).toBe("sent");
    });
});
