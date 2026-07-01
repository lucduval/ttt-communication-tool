/**
 * Personalised Channel Sender tests (PRD #8, issue #15).
 *
 * Drive the personalised adapter through its `sendBatch` seam against faked
 * Dynamics (`dynamicsRequest`), AI (`generatePersonalisedCopy`), and Graph
 * (`sendEmail`) boundaries plus a faked `ctx`, asserting the per-recipient
 * results it streams via `emit` and the successor delay it returns. Lifecycle
 * (claim, flush, mark-complete, reschedule) is the driver's and is tested
 * separately.
 *
 * The pure helpers (taxCalculator, emailTemplatePersonalised) run for real; only
 * the network-facing functions are faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";
import type { SendResult } from "../lib/channelSend";

const boundary = vi.hoisted(() => ({
    dynamicsRequest: vi.fn(),
    generatePersonalisedCopy: vi.fn(),
    sendEmail: vi.fn(),
}));

vi.mock("../lib/dynamics_auth", () => ({
    dynamicsRequest: boundary.dynamicsRequest,
}));

vi.mock("../lib/claude", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, generatePersonalisedCopy: boundary.generatePersonalisedCopy };
});

vi.mock("../lib/graph_client", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, sendEmail: boundary.sendEmail };
});

import { personalisedSender } from "../channelSenders";

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

const campaign = {
    _id: "c1",
    status: "active",
    name: "RA Plan 2026",
    subject: "{firstName}, your plan",
    fromMailbox: "sender@ttt.test",
    ccEmail: undefined,
    bccEmail: undefined,
    createOpportunities: false,
};

function createCtx() {
    const mutations: Array<{ name: string; args: any }> = [];
    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaignContent":
                    return { aiSystemPrompt: "sys", aiPrompt: "prompt" };
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            mutations.push({ name: getFunctionName(ref as any), args });
            return undefined;
        }),
        runAction: vi.fn(async () => undefined),
        scheduler: { runAfter: vi.fn(async () => undefined) },
    };
    return { ctx, mutations };
}

function collector() {
    const emitted: SendResult[] = [];
    const emit = async (results: SendResult[]) => {
        emitted.push(...results);
    };
    return { emitted, emit };
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVEX_SITE_URL;
});

describe("personalisedSender.sendBatch (faked Dynamics + AI + send boundary)", () => {
    it("emits sent (full tax→AI→send path) / missing-ITA34 per recipient and returns a successor delay", async () => {
        const batch = {
            _id: "pbatch-1" as any,
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
                return { fullname: "Pat Jones", firstname: "Pat", ttt_idnumber: null, riivo_age: 40 };
            }
            return { value: [] };
        });
        boundary.generatePersonalisedCopy.mockResolvedValue({ greeting: "Hi Pat", closingText: "Regards" });
        boundary.sendEmail.mockResolvedValue({ success: true });

        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        const ret = await personalisedSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients);

        const byId = Object.fromEntries(emitted.map((r) => [r.recipientId, r]));
        expect(byId.p1).toMatchObject({ success: true });
        expect(byId.p2).toMatchObject({ success: false, error: "No ITA34 data" });

        // Generation + send run once, only for the recipient with tax data; the
        // missing-ITA34 recipient never reaches generation or send.
        expect(boundary.generatePersonalisedCopy).toHaveBeenCalledTimes(1);
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1);

        // The adapter reports a successor delay; it never schedules a successor itself.
        expect(ret.nextDelayMs).toBe(500);
        expect(ret.halt).toBeUndefined();
    }, 20000);
});
