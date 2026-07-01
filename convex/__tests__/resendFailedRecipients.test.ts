/**
 * Operator-initiated resend to `failed` recipients (PRD #55, slice #60).
 *
 * Automatic sending is at-most-once: the eligibility rule (#56) refuses to
 * re-send any recipient with a *settled* row — including a terminal `failed`.
 * That is deliberate: a `failed` can be a delivered-but-429, so no automatic
 * path may touch it. Recovering a genuine failure is instead an explicit,
 * operator-initiated action that clears the targeted `failed` rows back to the
 * seed `pending` state so the eligibility rule makes them eligible again.
 *
 * These drive the pure `resendFailedRecipientsImpl` against a faked Convex `ctx`
 * (mirroring markAttempted.test.ts) and pin the truth table:
 *   - targeted `failed`        → reset to `pending` (errorMessage cleared)
 *   - non-targeted `failed`    → left `failed` (still skipped)
 *   - `attempted` (ambiguous)  → never touched, even if targeted
 *   - `sent`/`delivered`       → never touched, even if targeted
 *   - no row / already pending → no-op
 * plus an integration check that the *real* eligibility rule (#56) treats a
 * reset recipient as eligible again while everything else stays skipped.
 */
import { describe, it, expect } from "vitest";
import { resendFailedRecipientsImpl } from "../messages";
import { eligibleRecipients } from "../lib/sendEligibility";

type Message = {
    _id: string;
    campaignId: string;
    recipientId: string;
    recipientName: string;
    recipientEmail?: string;
    status: string;
    errorMessage?: string;
    channel: string;
};

function createCtx(messages: Message[]) {
    const patched: string[] = [];
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
        patch: async (id: string, fields: Record<string, unknown>) => {
            const m = messages.find((x) => x._id === id);
            if (m) Object.assign(m, fields);
            patched.push(id);
        },
    };
    return { ctx: { db } as any, messages, patched };
}

const row = (
    recipientId: string,
    status: string,
    extra: Partial<Message> = {}
): Message => ({
    _id: `m_${recipientId}`,
    campaignId: "c1",
    recipientId,
    recipientName: recipientId.toUpperCase(),
    recipientEmail: `${recipientId}@example.com`,
    status,
    channel: "email",
    ...extra,
});

describe("resendFailedRecipientsImpl (operator recovery of failed recipients)", () => {
    it("resets a targeted `failed` row to `pending` and clears its errorMessage", async () => {
        const { ctx, messages } = createCtx([
            row("r1", "failed", { errorMessage: "429 Too Many Requests" }),
        ]);

        const result = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        expect(result).toEqual({ reset: 1 });
        expect(messages[0].status).toBe("pending");
        expect(messages[0].errorMessage).toBeUndefined();
    });

    it("leaves a non-targeted `failed` recipient `failed` (still skipped)", async () => {
        const { ctx, messages } = createCtx([
            row("r1", "failed"),
            row("r2", "failed"),
        ]);

        const result = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        expect(result).toEqual({ reset: 1 });
        expect(messages.find((m) => m.recipientId === "r1")!.status).toBe("pending");
        expect(messages.find((m) => m.recipientId === "r2")!.status).toBe("failed");
    });

    it("never resets an `attempted` (ambiguous-but-maybe-delivered) row, even if targeted", async () => {
        const { ctx, messages, patched } = createCtx([row("r1", "attempted")]);

        const result = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        expect(result).toEqual({ reset: 0 });
        expect(patched).toHaveLength(0);
        expect(messages[0].status).toBe("attempted");
    });

    it("never resets a settled `sent`/`delivered` row, even if targeted", async () => {
        for (const settled of ["sent", "delivered"]) {
            const { ctx, messages, patched } = createCtx([row("r1", settled)]);

            const result = await resendFailedRecipientsImpl(ctx, {
                campaignId: "c1" as any,
                recipientIds: ["r1"],
            });

            expect(result).toEqual({ reset: 0 });
            expect(patched).toHaveLength(0);
            expect(messages[0].status).toBe(settled);
        }
    });

    it("is a no-op for a recipient with no row or an already-`pending` row", async () => {
        const { ctx, messages, patched } = createCtx([row("r1", "pending")]);

        const result = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1", "rMissing"],
        });

        expect(result).toEqual({ reset: 0 });
        expect(patched).toHaveLength(0);
        expect(messages[0].status).toBe("pending");
    });

    it("is idempotent — a second run resets nothing more", async () => {
        const { ctx } = createCtx([row("r1", "failed")]);

        const first = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });
        const second = await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        expect(first).toEqual({ reset: 1 });
        expect(second).toEqual({ reset: 0 });
    });

    it("scopes the reset per campaign — the same recipient in another campaign is untouched", async () => {
        const { ctx, messages } = createCtx([
            row("r1", "failed"),
            row("r1", "failed", { _id: "m_other", campaignId: "cOTHER" }),
        ]);

        await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        expect(messages.find((m) => m.campaignId === "c1")!.status).toBe("pending");
        expect(messages.find((m) => m.campaignId === "cOTHER")!.status).toBe("failed");
    });

    it("makes the reset recipient eligible again under the real rule, while settled and non-targeted stay skipped", async () => {
        const { ctx, messages } = createCtx([
            row("r1", "failed"), // targeted → recovered
            row("r2", "failed"), // genuine failure, NOT targeted → stays skipped
            row("r3", "attempted"), // ambiguous → stays skipped
            row("r4", "sent"), // clean success → stays skipped
        ]);

        await resendFailedRecipientsImpl(ctx, {
            campaignId: "c1" as any,
            recipientIds: ["r1"],
        });

        const batch = [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }];
        const eligible = eligibleRecipients(
            messages.map((m) => ({ recipientId: m.recipientId, status: m.status })),
            batch
        );

        expect(eligible.map((r) => r.id)).toEqual(["r1"]);
    });
});
