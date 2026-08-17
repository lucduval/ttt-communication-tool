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
import {
    templateVariableFields,
    guessVariableMapping,
    serialiseVariableMapping,
} from "../../src/components/recipients/whatsappVariableMapping";

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
        const ret = await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, async () => {});

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

    it("sends only the eligible subset and marks each attempted before its send (seam adoption, #61)", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [
                { id: "r1", phone: "+27821111111", name: "A" },
                { id: "r2", phone: "+27822222222", name: "B" },
            ],
        };
        // r2 is already handled (not in the driver's eligible set); only r1 sends.
        const eligible = [batch.recipients[0]];

        // Record the interleaving of markAttempted vs the Meta send so we can
        // assert the mark lands BEFORE the provider call (crash-blast-radius).
        const order: string[] = [];
        const markAttempted = vi.fn(async (ids: string[]) => {
            order.push(`mark:${ids.join(",")}`);
        });
        boundary.sendTemplateWithRetry.mockImplementation(async () => {
            order.push("send");
            return { status: "sent", wamid: "wamid.R1", attempts: 1, latencyMs: 1 };
        });

        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, eligible, markAttempted);

        // Only the eligible recipient reached the provider — r2 is never re-sent.
        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        expect(emitted.map((e) => e.recipientId)).toEqual(["r1"]);
        expect(emitted[0]).toMatchObject({ success: true, externalMessageId: "wamid.R1" });

        // markAttempted fired for exactly r1, immediately before its send.
        expect(markAttempted).toHaveBeenCalledTimes(1);
        expect(markAttempted).toHaveBeenCalledWith(["r1"]);
        expect(order).toEqual(["mark:r1", "send"]);
    });

    it("does not mark an invalid-phone recipient attempted (never handed to Meta)", async () => {
        const batch = {
            _id: "batch-1" as any,
            recipients: [{ id: "r1", phone: "", name: "A" }],
        };
        const markAttempted = vi.fn(async () => {});
        const { emitted, emit } = collector();
        const { ctx } = createCtx();
        await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, markAttempted);

        expect(boundary.sendTemplateWithRetry).not.toHaveBeenCalled();
        expect(markAttempted).not.toHaveBeenCalled();
        expect(emitted[0]).toMatchObject({ success: false });
        expect(emitted[0].error).toContain("Invalid phone number");
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
        const ret = await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, async () => {});

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

// ---------------------------------------------------------------------------
// Excel-driven upload path (PRD prd-bad-debt-excel-campaign.md, issue #70).
// A WhatsApp campaign whose `columnRoles` are set resolves every template
// variable — body + button suffix — from the recipient's uploaded row bag, and
// sends that recipient's pre-generated invoice PDF as the document header
// (uploaded to Meta per recipient → media id). Meta media upload + storage
// download URL + media-id cache are faked; buildTemplateRequestBody runs for real
// so we assert the exact Meta request body the row produced.
// ---------------------------------------------------------------------------

const uploadTemplate = {
    _id: "t-upload",
    name: "bad_debt_reminder",
    language: "en",
    body: "Hi, you owe {{1}} on {{2}}.",
    variables: ["1", "2"],
    headerType: "document",
    buttonType: "url",
    buttonText: "Pay Now",
    buttonUrl: "https://pay.ttt.io/{{1}}",
    buttonUrlVariable: "pay_token",
};

const uploadCampaign = {
    _id: "c-upload",
    status: "active",
    whatsappTemplateId: "t-upload",
    createDynamicsActivity: false,
    // Presence of columnRoles selects the file-as-source path.
    columnRoles: { trackingKey: "contactid", invoiceGuid: "invoiceguid" },
    whatsappVariableMappings: JSON.stringify({
        "1": "amount",
        "2": "invoice_date",
        pay_token: "pay_token",
    }),
};

function rowRecipient(id: string, cells: Record<string, string>, phone = "+27821234567") {
    return { id, phone, name: "Alice Smith", variables: JSON.stringify(cells) };
}

function createUploadCtx(opts: {
    pdfRefs: Array<{
        recipientId: string;
        storageId: string;
        whatsappMediaId?: string;
        whatsappMediaIdUploadedAt?: number;
    }>;
    downloadUrl?: string | null;
}) {
    const recorded: Array<{ recipientId: string; whatsappMediaId: string }> = [];
    const ctx = {
        runQuery: vi.fn(async (ref: unknown, args: any) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getWhatsAppTemplate":
                    return uploadTemplate;
                case "invoicePdfs:getWhatsAppPdfRefs":
                    return opts.pdfRefs;
                case "files:getDownloadUrlInternal":
                    return opts.downloadUrl === undefined
                        ? "https://convex.storage/" + args.storageId
                        : opts.downloadUrl;
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            if (getFunctionName(ref as any) === "invoicePdfs:recordWhatsAppMediaId") {
                recorded.push({ recipientId: args.recipientId, whatsappMediaId: args.whatsappMediaId });
            }
            return undefined;
        }),
        runAction: vi.fn(async () => undefined),
        scheduler: { runAfter: vi.fn(async () => undefined) },
    };
    return { ctx, recorded };
}

describe("whatsappSender.sendBatch — Excel-driven upload path (#70)", () => {
    it("renders body params + button suffix from the row and sends the per-recipient PDF as the document header", async () => {
        const batch = {
            _id: "batch-u" as any,
            recipients: [
                rowRecipient("guid-1", {
                    amount: "R1,234.56",
                    invoice_date: "21 July 2026",
                    pay_token: "xY9abc",
                }),
            ],
        };
        boundary.uploadWhatsAppMedia.mockResolvedValue({
            mediaId: "meta-media-1",
            mimeType: "application/pdf",
            sizeBytes: 2048,
        });
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.U1",
            attempts: 1,
            latencyMs: 5,
        });

        const order: string[] = [];
        const markAttempted = vi.fn(async (ids: string[]) => {
            order.push(`mark:${ids.join(",")}`);
        });
        boundary.sendTemplateWithRetry.mockImplementation(async () => {
            order.push("send");
            return { status: "sent", wamid: "wamid.U1", attempts: 1, latencyMs: 5 };
        });

        const { emitted, emit } = collector();
        const { ctx, recorded } = createUploadCtx({
            pdfRefs: [{ recipientId: "guid-1", storageId: "store-1" }],
        });

        await whatsappSender.sendBatch(
            ctx as any,
            uploadCampaign,
            batch,
            emit,
            batch.recipients,
            markAttempted,
        );

        // The stored PDF was uploaded to Meta as a document, and its id cached.
        expect(boundary.uploadWhatsAppMedia).toHaveBeenCalledTimes(1);
        const uploadArgs = boundary.uploadWhatsAppMedia.mock.calls[0][1];
        expect(uploadArgs).toMatchObject({
            sourceUrl: "https://convex.storage/store-1",
            headerType: "document",
            mimeTypeOverride: "application/pdf",
        });
        expect(recorded).toEqual([{ recipientId: "guid-1", whatsappMediaId: "meta-media-1" }]);

        // The Meta request body was built from the row: header doc = per-recipient
        // media id, body params from mapped columns, button suffix (not a URL).
        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        const sentBody = boundary.sendTemplateWithRetry.mock.calls[0][1];
        const comps = sentBody.template.components;
        expect(comps.find((c: any) => c.type === "header").parameters).toEqual([
            { type: "document", document: { id: "meta-media-1", filename: "invoice.pdf" } },
        ]);
        expect(comps.find((c: any) => c.type === "body").parameters).toEqual([
            { type: "text", text: "R1,234.56" },
            { type: "text", text: "21 July 2026" },
        ]);
        expect(comps.find((c: any) => c.type === "button")).toEqual({
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "xY9abc" }],
        });

        expect(emitted[0]).toMatchObject({ success: true, externalMessageId: "wamid.U1" });
        // Attempted before send — the crash-blast-radius seam holds with attachments.
        expect(order).toEqual(["mark:guid-1", "send"]);
    });

    it("reuses a fresh cached media id and skips the re-upload", async () => {
        const batch = {
            _id: "batch-u" as any,
            recipients: [rowRecipient("guid-1", { amount: "R9", invoice_date: "x", pay_token: "tok" })],
        };
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.U2",
            attempts: 1,
            latencyMs: 5,
        });

        const { emitted, emit } = collector();
        const { ctx, recorded } = createUploadCtx({
            pdfRefs: [
                {
                    recipientId: "guid-1",
                    storageId: "store-1",
                    whatsappMediaId: "cached-1",
                    whatsappMediaIdUploadedAt: Date.now(),
                },
            ],
        });

        await whatsappSender.sendBatch(
            ctx as any,
            uploadCampaign,
            batch,
            emit,
            batch.recipients,
            async () => {},
        );

        expect(boundary.uploadWhatsAppMedia).not.toHaveBeenCalled();
        expect(recorded).toEqual([]);
        const sentBody = boundary.sendTemplateWithRetry.mock.calls[0][1];
        expect(sentBody.template.components.find((c: any) => c.type === "header").parameters).toEqual([
            { type: "document", document: { id: "cached-1", filename: "invoice.pdf" } },
        ]);
        expect(emitted[0]).toMatchObject({ success: true, externalMessageId: "wamid.U2" });
    });

    it("holds a recipient with no generated PDF — never marked attempted, never sent", async () => {
        const batch = {
            _id: "batch-u" as any,
            recipients: [rowRecipient("guid-1", { amount: "R9", invoice_date: "x", pay_token: "tok" })],
        };
        const markAttempted = vi.fn(async () => {});
        const { emitted, emit } = collector();
        const { ctx } = createUploadCtx({ pdfRefs: [] });

        await whatsappSender.sendBatch(
            ctx as any,
            uploadCampaign,
            batch,
            emit,
            batch.recipients,
            markAttempted,
        );

        expect(boundary.uploadWhatsAppMedia).not.toHaveBeenCalled();
        expect(boundary.sendTemplateWithRetry).not.toHaveBeenCalled();
        expect(markAttempted).not.toHaveBeenCalled();
        expect(emitted[0]).toMatchObject({ success: false });
        expect(emitted[0].error).toContain("No generated invoice PDF");
    });

    it("sends only the eligible subset on the upload path (idempotency seam)", async () => {
        const batch = {
            _id: "batch-u" as any,
            recipients: [
                rowRecipient("guid-1", { amount: "R1", invoice_date: "a", pay_token: "t1" }, "+27821111111"),
                rowRecipient("guid-2", { amount: "R2", invoice_date: "b", pay_token: "t2" }, "+27822222222"),
            ],
        };
        // guid-2 already handled — not in the eligible set; only guid-1 sends.
        const eligible = [batch.recipients[0]];
        boundary.uploadWhatsAppMedia.mockResolvedValue({
            mediaId: "m1",
            mimeType: "application/pdf",
            sizeBytes: 1,
        });
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.only1",
            attempts: 1,
            latencyMs: 1,
        });

        const { emitted, emit } = collector();
        const { ctx } = createUploadCtx({
            pdfRefs: [
                { recipientId: "guid-1", storageId: "s1" },
                { recipientId: "guid-2", storageId: "s2" },
            ],
        });

        await whatsappSender.sendBatch(ctx as any, uploadCampaign, batch, emit, eligible, async () => {});

        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        expect(boundary.uploadWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(emitted.map((e) => e.recipientId)).toEqual(["guid-1"]);
    });
});

// ---------------------------------------------------------------------------
// Authoring → send seam (issue #86, PRD #84). The operator-authored variable→
// column mapping (produced by the pure `whatsappVariableMapping` core the
// recipients-step UI is a shell over) is persisted as `whatsappVariableMappings`
// and consumed unchanged by the send path: each recipient's positional body
// params and button suffix resolve from their own row, to the mapped number.
// A regression guards that a *missing* mapping no longer silently sends blank.
// ---------------------------------------------------------------------------

// A seed-shaped bad-debt template: positional body {{1}}{{2}}{{3}} + a "Pay now"
// URL button, with the seed's default logical names documenting each variable.
const seedShapedTemplate = {
    _id: "t-seed",
    name: "bad_debt_reminder",
    language: "en",
    body: "Hi {{1}}, invoice {{2}} · {{3}}.",
    variables: ["1", "2", "3"],
    variableMappings: JSON.stringify({
        "1": "first_name",
        "2": "invoice_number",
        "3": "amount_formatted",
        payment_link: "payment_link",
    }),
    headerType: undefined, // no document header — this test isolates variable resolution
    buttonType: "url",
    buttonText: "Pay now",
    buttonUrl: "https://payment-link-ttt.azurewebsites.net/p/{{1}}",
    buttonUrlVariable: "payment_link",
};

function createSeedCtx() {
    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getWhatsAppTemplate":
                    return seedShapedTemplate;
                case "invoicePdfs:getWhatsAppPdfRefs":
                    return [];
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

describe("whatsappSender.sendBatch — authored variable→column mapping (#86)", () => {
    // A conventionally-headed export; the authoring core guesses a complete mapping.
    const columns = [
        { index: 0, header: "contactid" },
        { index: 1, header: "First Name" },
        { index: 2, header: "Invoice Number" },
        { index: 3, header: "Amount Formatted" },
        { index: 4, header: "Payment Link" },
    ];
    const fields = templateVariableFields(seedShapedTemplate);
    const authoredMapping = serialiseVariableMapping(fields, guessVariableMapping(fields, columns));

    const row = {
        id: "guid-1",
        phone: "+27 82 555 0100",
        name: "",
        variables: JSON.stringify({
            contactid: "guid-1",
            "First Name": "Thandi",
            "Invoice Number": "INV-2048",
            "Amount Formatted": "R1,234.56",
            "Payment Link": "xY9abc",
        }),
    };

    it("resolves each positional body param + button suffix from the row and sends to the mapped number", async () => {
        const campaign = {
            _id: "c-seed",
            status: "active",
            whatsappTemplateId: "t-seed",
            createDynamicsActivity: false,
            columnRoles: { trackingKey: "contactid", phone: "First Name" },
            whatsappVariableMappings: authoredMapping,
        };
        const batch = { _id: "batch-s" as any, recipients: [row] };
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.S1",
            attempts: 1,
            latencyMs: 5,
        });

        const { emitted, emit } = collector();
        const { ctx } = createSeedCtx();
        await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, async () => {});

        expect(boundary.sendTemplateWithRetry).toHaveBeenCalledTimes(1);
        const sentBody = boundary.sendTemplateWithRetry.mock.calls[0][1];
        // Sent to the recipient's own (normalised) number.
        expect(sentBody.to).toBe("27825550100");
        const comps = sentBody.template.components;
        // Body params render the row's real values, in positional order.
        expect(comps.find((c: any) => c.type === "body").parameters).toEqual([
            { type: "text", text: "Thandi" },
            { type: "text", text: "INV-2048" },
            { type: "text", text: "R1,234.56" },
        ]);
        // Button carries the per-recipient payment token/suffix (not a full URL).
        expect(comps.find((c: any) => c.type === "button").parameters).toEqual([
            { type: "text", text: "xY9abc" },
        ]);
        expect(emitted[0]).toMatchObject({ success: true, externalMessageId: "wamid.S1" });
    });

    it("regression: with no mapping the positional body params send blank (the bug the authoring closes)", async () => {
        // A campaign the wizard never populated a mapping for — the pre-#86 state.
        const campaign = {
            _id: "c-nomap",
            status: "active",
            whatsappTemplateId: "t-seed",
            createDynamicsActivity: false,
            columnRoles: { trackingKey: "contactid", phone: "First Name" },
            // whatsappVariableMappings intentionally absent.
        };
        const batch = { _id: "batch-n" as any, recipients: [row] };
        boundary.sendTemplateWithRetry.mockResolvedValue({
            status: "sent",
            wamid: "wamid.N1",
            attempts: 1,
            latencyMs: 5,
        });

        const { emit } = collector();
        const { ctx } = createSeedCtx();
        await whatsappSender.sendBatch(ctx as any, campaign, batch, emit, batch.recipients, async () => {});

        const sentBody = boundary.sendTemplateWithRetry.mock.calls[0][1];
        const bodyParams = sentBody.template.components.find((c: any) => c.type === "body").parameters;
        // Positional variables "1"/"2"/"3" fall back to columns literally named
        // "1"/"2"/"3", which do not exist — so every param is blank. The authoring
        // core's validation is what stops the operator ever reaching this state
        // (see whatsappVariableMapping.test.ts), which is exactly what #86 adds.
        expect(bodyParams).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
        // And the authored mapping — from the same row's headers — would not be blank.
        expect(authoredMapping).not.toBe("{}");
    });
});
