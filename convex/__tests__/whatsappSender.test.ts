/**
 * WhatsApp Channel Sender tests (PRD #8, issue #14).
 *
 * Drive the WhatsApp adapter through its `sendBatch` seam against a faked Meta
 * send boundary (`sendTemplateWithRetry`) and a faked `ctx`, asserting the
 * per-recipient results it streams via `emit`, the `externalMessageId` it
 * surfaces on success, and the `halt` it returns when a template hits three
 * consecutive permanent errors. Lifecycle (claim, flush, mark-complete,
 * reschedule) is the driver's and is tested separately in
 * convex/lib/__tests__/channelSend.test.ts.
 *
 * The pure helpers (normalizeToE164Digits, buildTemplateRequestBody,
 * RateLimiter, isTemplatePermanentError) run for real; only the network-facing
 * functions are faked. getMetaWhatsAppConfig is faked with maxConcurrent: 1 so
 * the three-strike path is deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";
import type { SendResult } from "../lib/channelSend";

const boundary = vi.hoisted(() => ({
    sendTemplateWithRetry: vi.fn(),
    uploadWhatsAppMedia: vi.fn(),
    notifyTinaOfOutboundTemplate: vi.fn(),
    logWhatsAppActivity: vi.fn(),
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
        uploadWhatsAppMedia: boundary.uploadWhatsAppMedia,
    };
});

vi.mock("../lib/notifyTina", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, notifyTinaOfOutboundTemplate: boundary.notifyTinaOfOutboundTemplate };
});

vi.mock("../lib/dynamics_logging", () => ({
    logWhatsAppActivity: boundary.logWhatsAppActivity,
    logEmailActivity: vi.fn(),
}));

import { whatsappSender } from "../channelSenders";

const template = {
    _id: "t1",
    name: "promo",
    language: "en",
    variables: [],
    body: "Hi there",
    headerType: undefined,
};

function createCtx() {
    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getWhatsAppTemplate":
                    return template;
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
    whatsappTemplateId: "t1",
    createDynamicsActivity: false,
};

function collector() {
    const emitted: SendResult[] = [];
    const emit = async (results: SendResult[]) => {
        emitted.push(...results);
    };
    return { emitted, emit };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("whatsappSender.sendBatch (faked Meta send boundary)", () => {
    it("emits sent-with-wamid / invalid-phone per recipient and returns a successor delay", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [
                { id: "r1", phone: "+27 82 123 4567", name: "Alice Smith" },
                { id: "r2", phone: "", name: "Bob" },
            ],
        };
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.ABC",
            attempts: 1,
            latencyMs: 10,
        });

        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        const ret = await whatsappSender.sendBatch(ctx as any, campaign, batch, emit);

        const byId = Object.fromEntries(emitted.map((r) => [r.recipientId, r]));
        expect(byId.r1).toMatchObject({ success: true, externalMessageId: "wamid.ABC" });
        expect(byId.r2).toMatchObject({ success: false });
        expect(byId.r2.error).toContain("Invalid phone number");

        // Only the valid recipient reaches the send boundary.
        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);

        // The adapter reports a successor delay; it never schedules a successor itself.
        expect(ret.nextDelayMs).toBe(500);
        expect(ret.halt).toBeUndefined();
    });

    it("returns { halt } after three consecutive permanent template errors", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [
                { id: "r1", phone: "+27821111111", name: "A" },
                { id: "r2", phone: "+27822222222", name: "B" },
                { id: "r3", phone: "+27823333333", name: "C" },
                { id: "r4", phone: "+27824444444", name: "D" },
            ],
        };
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "failed",
            errorCode: 132001,
            errorMessage: "Template paused",
            attempts: 1,
            latencyMs: 10,
        });

        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        const ret = await whatsappSender.sendBatch(ctx as any, campaign, batch, emit);

        // The three-strike abort surfaces as a halt so the driver schedules no successor.
        expect(ret.halt).toBeTruthy();

        // With maxConcurrent: 1 every recipient runs its send before any abort short-circuit
        // can take effect, so all four surface the permanent error code.
        expect(emitted).toHaveLength(4);
        for (const r of emitted) {
            expect(r.success).toBe(false);
            expect(r.error).toContain("code=132001");
        }
    });
});
