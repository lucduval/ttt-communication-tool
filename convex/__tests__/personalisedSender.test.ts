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
        const ret = await personalisedSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, async () => {});

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

    it("sends only the eligible subset and marks each attempted before its send (seam adoption, #61)", async () => {
        const batch = {
            _id: "pbatch-1" as any,
            recipients: [
                { id: "p1", email: "pat@example.com", name: "Pat Jones" },
                { id: "p2", email: "sam@example.com", name: "Sam Lee" },
            ],
        };
        // p2 is already handled (not in the driver's eligible set); only p1 sends,
        // even though both have full tax data.
        const eligible = [batch.recipients[0]];

        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) return { value: [ita34] };
            if (path.includes("riivo_irp5s")) return { value: [] };
            if (path.includes("contacts(")) {
                return { fullname: "Pat Jones", firstname: "Pat", ttt_idnumber: null, riivo_age: 40 };
            }
            return { value: [] };
        });
        boundary.generatePersonalisedCopy.mockResolvedValue({ greeting: "Hi Pat", closingText: "Regards" });

        const order: string[] = [];
        const markAttempted = vi.fn(async (ids: string[]) => {
            order.push(`mark:${ids.join(",")}`);
        });
        boundary.sendEmail.mockImplementation(async () => {
            order.push("send");
            return { success: true };
        });

        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        await personalisedSender.sendBatch(ctx as any, campaign, batch, emit, eligible, markAttempted);

        // Only the eligible recipient reached generation + send — p2 is never re-sent.
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1);
        expect(emitted.map((e) => e.recipientId)).toEqual(["p1"]);
        expect(emitted[0]).toMatchObject({ success: true });

        // markAttempted fired for exactly p1, immediately before its send.
        expect(markAttempted).toHaveBeenCalledTimes(1);
        expect(markAttempted).toHaveBeenCalledWith(["p1"]);
        expect(order).toEqual(["mark:p1", "send"]);

        // The adapter no longer pre-creates rows itself — row creation is the seam's
        // (seed createBatches + markAttempted), matching the email path.
        const mutationNames = ctx.runMutation.mock.calls.map((c: any[]) => getFunctionName(c[0] as any));
        expect(mutationNames).not.toContain("messages:createBatch");
    }, 20000);
});

describe("personalisedSender.sendBatch consultant CC (PRD #78, #82)", () => {
    // A recipient that reaches the send (has ITA34 + contact), carrying an
    // uploaded-row variables bag whose "Consultant" cell names its consultant.
    function fakeDynamicsWithTax() {
        boundary.dynamicsRequest.mockImplementation(async (path: string) => {
            if (path.includes("riivo_ita34s")) return { value: [ita34] };
            if (path.includes("riivo_irp5s")) return { value: [] };
            if (path.includes("contacts(")) {
                return { fullname: "Pat Jones", firstname: "Pat", ttt_idnumber: null, riivo_age: 40 };
            }
            return { value: [] };
        });
        boundary.generatePersonalisedCopy.mockResolvedValue({ greeting: "Hi Pat", closingText: "Regards" });
        boundary.sendEmail.mockResolvedValue({ success: true });
    }

    function recipient(variables?: Record<string, string>) {
        return {
            id: "p1",
            email: "pat@example.com",
            name: "Pat Jones",
            ...(variables ? { variables: JSON.stringify(variables) } : {}),
        };
    }

    async function ccOfSingleSend(campaignOverride: any, rcpt: any) {
        const batch = { _id: "pbatch-1" as any, recipients: [rcpt] };
        const { emit } = collector();
        const { ctx } = createCtx();
        await personalisedSender.sendBatch(
            ctx as any,
            { ...campaign, ...campaignOverride },
            batch,
            emit,
            batch.recipients,
            async () => {}
        );
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1);
        return boundary.sendEmail.mock.calls[0][0].ccRecipients;
    }

    it("CCs the recipient's consultant merged with the static CC (both set)", async () => {
        fakeDynamicsWithTax();
        const cc = await ccOfSingleSend(
            { ccEmail: "audit@ttt.test", columnRoles: { trackingKey: "Id", ccAddress: "Consultant" } },
            recipient({ Consultant: "cons@firm.co" })
        );
        expect(cc).toEqual([{ email: "audit@ttt.test" }, { email: "cons@firm.co" }]);
    }, 20000);

    it("CCs the consultant only when no static CC is set", async () => {
        fakeDynamicsWithTax();
        const cc = await ccOfSingleSend(
            { ccEmail: undefined, columnRoles: { trackingKey: "Id", ccAddress: "Consultant" } },
            recipient({ Consultant: "cons@firm.co" })
        );
        expect(cc).toEqual([{ email: "cons@firm.co" }]);
    }, 20000);

    it("stays static-only (unchanged) when no ccAddress role is designated", async () => {
        fakeDynamicsWithTax();
        const cc = await ccOfSingleSend(
            { ccEmail: "audit@ttt.test", columnRoles: { trackingKey: "Id" } },
            recipient({ Consultant: "cons@firm.co" })
        );
        expect(cc).toEqual([{ email: "audit@ttt.test" }]);
    }, 20000);

    it("no CC when the recipient's consultant cell is blank (recipient still sends)", async () => {
        fakeDynamicsWithTax();
        const cc = await ccOfSingleSend(
            { ccEmail: undefined, columnRoles: { trackingKey: "Id", ccAddress: "Consultant" } },
            recipient({ Consultant: "   " })
        );
        expect(cc).toBeUndefined();
        expect(boundary.sendEmail).toHaveBeenCalledTimes(1); // still sent
    }, 20000);
});
