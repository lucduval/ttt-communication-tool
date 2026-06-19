/**
 * Characterization tests (PRD #8, issue #12).
 *
 * These pin each channel's *current* per-recipient output on the live send path
 * before the Channel Send driver / Channel Sender refactor (#13–#15). They drive
 * the real batch-processing action handlers (`processEmailBatch`,
 * `processWhatsAppBatch`, `processPersonalisedBatch`) with a faked Convex `ctx`
 * and faked send boundaries, then assert the observable per-recipient results
 * that get flushed to the DB via `messages.updateStatusBatch`.
 *
 * Prior art: library logic tested against a faked request boundary
 * (convex/lib/__tests__/whatsapp.test.ts, contactQuery.test.ts). Here the
 * "observable result" is the status update written per recipient, not any
 * private helper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";

// Faked send boundaries. Declared via vi.hoisted so the vi.mock factories
// (which are hoisted above imports) can reference them.
const boundary = vi.hoisted(() => ({
    sendEmailBatch: vi.fn(),
    sendEmail: vi.fn(),
    sendTemplateWithRetry: vi.fn(),
    generatePersonalisedCopy: vi.fn(),
    dynamicsRequest: vi.fn(),
}));

vi.mock("../lib/graph_client", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, sendEmailBatch: boundary.sendEmailBatch, sendEmail: boundary.sendEmail };
});

vi.mock("../lib/whatsapp", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return {
        ...actual,
        // Fake the network send + media upload; keep the real builders, the
        // E.164 normaliser, the permanent-error classifier, and the RateLimiter.
        sendTemplateWithRetry: boundary.sendTemplateWithRetry,
        uploadWhatsAppMedia: vi.fn(),
        getMetaWhatsAppConfig: () => ({
            token: "tok",
            phoneNumberId: "1",
            sendUrl: "https://example.test/messages",
            graphApiVersion: "v22.0",
            maxSendPerSecond: 1000,
            // Serialise sends so the three-strike accounting is deterministic.
            maxConcurrent: 1,
            retryMaxAttempts: 1,
            retryBaseDelayMs: 1,
            dailyTierLimit: 100000,
        }),
    };
});

vi.mock("../lib/claude", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, generatePersonalisedCopy: boundary.generatePersonalisedCopy };
});

vi.mock("../lib/dynamics_auth", () => ({
    dynamicsRequest: boundary.dynamicsRequest,
}));

vi.mock("../lib/notifyTina", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, notifyTinaOfOutboundTemplate: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../lib/dynamics_logging", () => ({
    logEmailActivity: vi.fn().mockResolvedValue(undefined),
    logWhatsAppActivity: vi.fn().mockResolvedValue(undefined),
}));

import {
    processEmailBatch,
    processWhatsAppBatch,
    processPersonalisedBatch,
} from "../campaignQueue";

type AnyHandler = { _handler: (ctx: unknown, args: unknown) => Promise<unknown> };
const emailHandler = (processEmailBatch as unknown as AnyHandler)._handler;
const whatsappHandler = (processWhatsAppBatch as unknown as AnyHandler)._handler;
const personalisedHandler = (processPersonalisedBatch as unknown as AnyHandler)._handler;

type Update = {
    recipientId: string;
    status: "sent" | "failed";
    sentAt?: number;
    errorMessage?: string;
    externalMessageId?: string;
};

interface CtxOpts {
    campaign?: unknown;
    campaignContent?: unknown;
    batch?: unknown;
    template?: unknown;
    alreadySent?: string[];
    acquired?: boolean;
    hasMoreBatches?: boolean;
}

function createCtx(opts: CtxOpts) {
    const updateBatches: Update[][] = [];
    const scheduled: string[] = [];
    const mutations: Array<{ name: string; args: any }> = [];

    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return opts.campaign;
                case "campaignBatches:getCampaignContent":
                    return opts.campaignContent ?? null;
                case "campaignBatches:getNextPendingBatchInternal":
                    return opts.batch;
                case "campaignBatches:getWhatsAppTemplate":
                    return opts.template;
                case "messages:getSentRecipientIds":
                    return opts.alreadySent ?? [];
                case "personalisedHistory:getContactIdsForCampaignName":
                    return [];
                case "files:getDownloadUrlInternal":
                    return null;
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            const name = getFunctionName(ref as any);
            mutations.push({ name, args });
            if (name === "messages:updateStatusBatch") updateBatches.push(args.updates);
            if (name === "campaignBatches:markBatchProcessing")
                return { acquired: opts.acquired ?? true };
            if (name === "campaignBatches:markBatchComplete")
                return { hasMoreBatches: opts.hasMoreBatches ?? false };
            if (name === "campaignBatches:markBatchFailed")
                return { hasMoreBatches: opts.hasMoreBatches ?? false };
            return undefined;
        }),
        runAction: vi.fn(async () => undefined),
        scheduler: {
            runAfter: vi.fn(async (_ms: number, ref: unknown) => {
                scheduled.push(getFunctionName(ref as any));
            }),
            runAt: vi.fn(async (_ts: number, ref: unknown) => {
                scheduled.push(getFunctionName(ref as any));
            }),
        },
    };

    return { ctx, updateBatches, scheduled, mutations };
}

/** Collapse every flushed update batch into a recipientId → final update map. */
function resultsByRecipient(updateBatches: Update[][]): Record<string, Update> {
    const map: Record<string, Update> = {};
    for (const updates of updateBatches) {
        for (const u of updates) map[u.recipientId] = u;
    }
    return map;
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVEX_SITE_URL;
});

describe("email per-recipient output (faked Graph $batch boundary)", () => {
    const campaign = {
        status: "active",
        subject: "Hello {firstName}",
        fromMailbox: "sender@ttt.test",
        ccEmail: undefined,
        bccEmail: undefined,
        createDynamicsActivity: false,
        createOpportunities: false,
    };
    const campaignContent = { htmlBody: "<p>Hi {firstName}</p>", fontSize: "15px", attachments: [] };

    it("pins sent / invalid-address / Graph-failure outcomes per recipient", async () => {
        const batch = {
            _id: "batch-1",
            recipients: [
                { id: "r1", email: "alice@example.com", name: "Alice Smith" },
                { id: "r2", email: "not-an-email", name: "Bob" },
                { id: "r3", email: "carol@example.com", name: "Carol" },
            ],
        };
        // Phase-1 validation drops r2 before it reaches Graph; r1 and r3 are sent
        // via $batch. We fail carol to pin a provider-level failure.
        boundary.sendEmailBatch.mockImplementation(async (msgs: any[]) =>
            msgs.map((m) =>
                m.toRecipients[0].email === "carol@example.com"
                    ? { success: false, error: "Graph rejected" }
                    : { success: true }
            )
        );

        const { ctx, updateBatches, scheduled } = createCtx({
            campaign,
            campaignContent,
            batch,
            hasMoreBatches: true,
        });

        await emailHandler(ctx, { campaignId: "c1" });

        const results = resultsByRecipient(updateBatches);
        expect(results.r1.status).toBe("sent");
        expect(results.r2).toMatchObject({
            status: "failed",
            errorMessage: 'Invalid email address: "not-an-email"',
        });
        expect(results.r3).toMatchObject({ status: "failed", errorMessage: "Graph rejected" });

        // Only the two valid recipients reach the $batch send.
        expect(boundary.sendEmailBatch).toHaveBeenCalledTimes(1);
        expect(boundary.sendEmailBatch.mock.calls[0][0]).toHaveLength(2);

        // A successor is scheduled while batches remain.
        expect(scheduled).toContain("campaignQueue:processEmailBatch");
    });

    it("short-circuits a paused campaign without sending", async () => {
        const { ctx, updateBatches } = createCtx({
            campaign: { ...campaign, status: "paused" },
            campaignContent,
            batch: { _id: "batch-1", recipients: [{ id: "r1", email: "a@b.com", name: "A" }] },
        });

        await emailHandler(ctx, { campaignId: "c1" });

        expect(boundary.sendEmailBatch).not.toHaveBeenCalled();
        expect(updateBatches).toHaveLength(0);
    });

    it("skips recipients already flushed as sent (idempotent recovery)", async () => {
        const batch = {
            _id: "batch-1",
            recipients: [
                { id: "r1", email: "alice@example.com", name: "Alice" },
                { id: "r2", email: "bob@example.com", name: "Bob" },
            ],
        };
        boundary.sendEmailBatch.mockImplementation(async (msgs: any[]) =>
            msgs.map(() => ({ success: true }))
        );

        const { ctx } = createCtx({
            campaign,
            campaignContent,
            batch,
            alreadySent: ["r1"],
        });

        await emailHandler(ctx, { campaignId: "c1" });

        // Only r2 is sent; r1 is skipped entirely.
        expect(boundary.sendEmailBatch.mock.calls[0][0]).toHaveLength(1);
        expect(boundary.sendEmailBatch.mock.calls[0][0][0].toRecipients[0].email).toBe(
            "bob@example.com"
        );
    });
});

describe("WhatsApp per-recipient output (faked send boundary)", () => {
    const campaign = {
        status: "active",
        whatsappTemplateId: "tmpl-1",
        createDynamicsActivity: false,
    };
    const template = {
        _id: "tmpl-1",
        name: "welcome",
        language: "en",
        variables: [],
        headerType: "TEXT",
        body: "Welcome",
    };

    it("pins sent (with wamid) and invalid-phone outcomes per recipient", async () => {
        const batch = {
            _id: "wbatch-1",
            recipients: [
                { id: "w1", phone: "+27821234567", name: "Alice" },
                { id: "w2", phone: "invalid", name: "Bob" },
            ],
        };
        boundary.sendTemplateWithRetry.mockResolvedValue({ status: "sent", wamid: "wamid-1" });

        const { ctx, updateBatches, scheduled } = createCtx({
            campaign,
            template,
            batch,
            hasMoreBatches: true,
        });

        await whatsappHandler(ctx, { campaignId: "c1" });

        const results = resultsByRecipient(updateBatches);
        expect(results.w1).toMatchObject({ status: "sent", externalMessageId: "wamid-1" });
        expect(results.w2).toMatchObject({
            status: "failed",
            errorMessage: "Invalid phone number: invalid",
        });
        // The invalid phone never reaches the send boundary.
        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        expect(scheduled).toContain("campaignQueue:processWhatsAppBatch");
    });

    it("halts after three consecutive permanent template errors and stops scheduling", async () => {
        const batch = {
            _id: "wbatch-1",
            recipients: [
                { id: "w1", phone: "+27821111111", name: "A" },
                { id: "w2", phone: "+27822222222", name: "B" },
                { id: "w3", phone: "+27823333333", name: "C" },
                { id: "w4", phone: "+27824444444", name: "D" },
            ],
        };
        // 132001 is a permanent template error code.
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "failed",
            errorCode: 132001,
            errorMessage: "template paused",
        });

        const { ctx, updateBatches, scheduled } = createCtx({
            campaign,
            template,
            batch,
            hasMoreBatches: true,
        });

        await whatsappHandler(ctx, { campaignId: "c1" });

        const results = resultsByRecipient(updateBatches);
        for (const id of ["w1", "w2", "w3", "w4"]) {
            expect(results[id].status).toBe("failed");
            expect(results[id].errorMessage).toContain("code=132001");
        }
        // The three-strike abort stops the driver scheduling a successor batch,
        // even though more batches remain.
        expect(scheduled).not.toContain("campaignQueue:processWhatsAppBatch");
    });
});

describe("personalised per-recipient output (faked Dynamics + AI + send boundary)", () => {
    const campaign = {
        status: "active",
        name: "RA Plan 2026",
        subject: "{firstName}, your plan",
        fromMailbox: "sender@ttt.test",
        ccEmail: undefined,
        bccEmail: undefined,
        createOpportunities: false,
    };
    const campaignContent = { aiSystemPrompt: "sys", aiPrompt: "prompt" };

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

    it("pins sent (full tax→AI→send path) and missing-ITA34 outcomes per recipient", async () => {
        const batch = {
            _id: "pbatch-1",
            recipients: [
                { id: "p1", email: "pat@example.com", name: "Pat Jones" },
                { id: "p2", email: "sam@example.com", name: "Sam" },
            ],
        };

        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) {
                // p1 has an ITA34; p2 does not.
                return { value: path.includes("p1") ? [ita34] : [] };
            }
            if (path.includes("riivo_irp5s")) return { value: [] };
            if (path.includes("contacts(")) {
                return {
                    fullname: "Pat Jones",
                    firstname: "Pat",
                    ttt_idnumber: null,
                    riivo_age: 40,
                };
            }
            return { value: [] };
        });
        boundary.generatePersonalisedCopy.mockResolvedValue({
            greeting: "Hi Pat",
            closingText: "Regards",
        });
        boundary.sendEmail.mockResolvedValue({ success: true });

        const { ctx, updateBatches } = createCtx({
            campaign,
            campaignContent,
            batch,
            hasMoreBatches: false,
        });

        await personalisedHandler(ctx, { campaignId: "c1" });

        const results = resultsByRecipient(updateBatches);
        expect(results.p1.status).toBe("sent");
        expect(results.p2).toMatchObject({ status: "failed", errorMessage: "No ITA34 data" });

        // The sequential tax-calc + Claude generation runs once for the only
        // recipient that has tax data; the missing-ITA34 recipient never reaches
        // generation or send.
        expect(boundary.generatePersonalisedCopy).toHaveBeenCalledTimes(1);
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1);
    }, 20000);
});
