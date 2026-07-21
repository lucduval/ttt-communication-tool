/**
 * Start-campaign wiring tests (PRD #74, issue #75) — faked `ctx`, sendGate style.
 *
 * These pin the campaign-start contract for the email-type slice: the operator's
 * Marketing/Utility selection is persisted on the `campaigns` record so the
 * transactional decision is auditable, and an unset selection is stored as unset
 * (treated downstream as Marketing, preserving today's unsubscribe-present behaviour).
 * They drive `startCampaignImpl` against a faked Convex `ctx`, asserting the inserted
 * campaign document — not the mutation plumbing.
 */
import { describe, it, expect, vi } from "vitest";
import { startCampaignImpl } from "../campaignBatches";

function createCtx() {
    const inserts: Array<{ table: string; doc: any }> = [];
    let seq = 0;
    const ctx = {
        auth: { getUserIdentity: vi.fn(async () => ({ subject: "user-1" })) },
        db: {
            insert: vi.fn(async (table: string, doc: any) => {
                inserts.push({ table, doc });
                return `${table}-${seq++}`;
            }),
            query: vi.fn(() => ({
                withIndex: () => ({ first: async () => null }),
            })),
        },
    };
    return { ctx, inserts };
}

const baseArgs = { name: "Bad-debt reminder", channel: "email" as const, recipients: [] };

describe("startCampaignImpl — email type persistence", () => {
    it("persists a Utility selection on the campaign record", async () => {
        const { ctx, inserts } = createCtx();

        await startCampaignImpl(ctx as any, { ...baseArgs, emailType: "utility" });

        const campaign = inserts.find((i) => i.table === "campaigns");
        expect(campaign?.doc.emailType).toBe("utility");
    });

    it("persists a Marketing selection on the campaign record", async () => {
        const { ctx, inserts } = createCtx();

        await startCampaignImpl(ctx as any, { ...baseArgs, emailType: "marketing" });

        const campaign = inserts.find((i) => i.table === "campaigns");
        expect(campaign?.doc.emailType).toBe("marketing");
    });

    it("stores emailType unset when the operator makes no choice (treated as Marketing downstream)", async () => {
        const { ctx, inserts } = createCtx();

        await startCampaignImpl(ctx as any, { ...baseArgs });

        const campaign = inserts.find((i) => i.table === "campaigns");
        expect(campaign?.doc.emailType).toBeUndefined();
    });
});
