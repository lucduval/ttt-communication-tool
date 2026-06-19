/**
 * Email Channel Sender tests (PRD #8, issue #13).
 *
 * Drive the email adapter through its `sendBatch` seam against a faked Graph
 * `$batch` boundary and a faked `ctx`, asserting the per-recipient results it
 * streams via `emit` and the successor `nextDelayMs` it returns. Lifecycle
 * (claim, flush, mark-complete, reschedule) is the driver's and is tested
 * separately in convex/lib/__tests__/channelSend.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";
import type { SendResult } from "../lib/channelSend";

const boundary = vi.hoisted(() => ({ sendEmailBatch: vi.fn() }));

vi.mock("../lib/graph_client", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, sendEmailBatch: boundary.sendEmailBatch };
});

import { emailSender } from "../channelSenders";

interface CtxOpts {
    campaignContent?: unknown;
    alreadySent?: string[];
}

function createCtx(opts: CtxOpts) {
    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaignContent":
                    return opts.campaignContent ?? null;
                case "messages:getSentRecipientIds":
                    return opts.alreadySent ?? [];
                case "files:getDownloadUrlInternal":
                    return null;
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async () => undefined),
        runAction: vi.fn(async () => undefined),
        scheduler: { runAfter: vi.fn(async () => undefined) },
    };
    return { ctx };
}

const campaign = {
    _id: "c1",
    status: "active",
    subject: "Hello {firstName}",
    fromMailbox: "sender@ttt.test",
    createDynamicsActivity: false,
    createOpportunities: false,
};
const campaignContent = { htmlBody: "<p>Hi {firstName}</p>", fontSize: "15px", attachments: [] };

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVEX_SITE_URL;
});

describe("emailSender.sendBatch (faked Graph $batch boundary)", () => {
    it("emits sent / invalid-address / Graph-failure per recipient and returns a successor delay", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [
                { id: "r1", email: "alice@example.com", name: "Alice Smith" },
                { id: "r2", email: "not-an-email", name: "Bob" },
                { id: "r3", email: "carol@example.com", name: "Carol" },
            ],
        };
        boundary.sendEmailBatch.mockImplementation(async (msgs: any[]) =>
            msgs.map((m) =>
                m.toRecipients[0].email === "carol@example.com"
                    ? { success: false, error: "Graph rejected" }
                    : { success: true }
            )
        );

        const emitted: SendResult[] = [];
        const emit = async (results: SendResult[]) => {
            emitted.push(...results);
        };

        const { ctx } = createCtx({ campaignContent });
        const ret = await emailSender.sendBatch(ctx as any, campaign, batch, emit);

        const byId = Object.fromEntries(emitted.map((r) => [r.recipientId, r]));
        expect(byId.r1).toMatchObject({ success: true });
        expect(byId.r2).toMatchObject({
            success: false,
            error: 'Invalid email address: "not-an-email"',
        });
        expect(byId.r3).toMatchObject({ success: false, error: "Graph rejected" });

        // Only the two valid recipients reach the $batch send.
        expect(boundary.sendEmailBatch).toHaveBeenCalledTimes(1);
        expect(boundary.sendEmailBatch.mock.calls[0][0]).toHaveLength(2);

        // The adapter reports a successor delay; it never schedules a successor itself.
        expect(ret.nextDelayMs).toBeGreaterThan(0);
        expect(ret.halt).toBeUndefined();
    });

    it("skips recipients already flushed as sent (idempotent recovery)", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [
                { id: "r1", email: "alice@example.com", name: "Alice" },
                { id: "r2", email: "bob@example.com", name: "Bob" },
            ],
        };
        boundary.sendEmailBatch.mockImplementation(async (msgs: any[]) => msgs.map(() => ({ success: true })));

        const emitted: SendResult[] = [];
        const emit = async (results: SendResult[]) => {
            emitted.push(...results);
        };

        const { ctx } = createCtx({ campaignContent, alreadySent: ["r1"] });
        await emailSender.sendBatch(ctx as any, campaign, batch, emit);

        // Only r2 reaches the send boundary; r1 is skipped and never emitted.
        expect(boundary.sendEmailBatch.mock.calls[0][0]).toHaveLength(1);
        expect(boundary.sendEmailBatch.mock.calls[0][0][0].toRecipients[0].email).toBe(
            "bob@example.com"
        );
        expect(emitted.map((r) => r.recipientId)).toEqual(["r2"]);
    });
});
