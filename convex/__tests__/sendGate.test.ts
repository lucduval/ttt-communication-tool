/**
 * Send-gate tests (PRD `prd-bad-debt-excel-campaign.md`, #68/#69/#70 wiring).
 *
 * `scheduleSendAfterOptionalPregen` is the single fork both upload kickoff paths
 * (`queueCampaignBatches` + `kickoffScheduledCampaign`) call once a campaign's
 * batches are seeded. It decides whether the send starts directly, or is gated
 * behind per-recipient invoice-PDF pre-generation. These tests drive that fork
 * against a faked `ctx`, asserting exactly which scheduler ref it hands off to —
 * the "generate all, then send" gate for upload campaigns, and the unchanged
 * direct send for every other campaign.
 */
import { describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { scheduleSendAfterOptionalPregen } from "../campaignQueue";

function createCtx(campaign: unknown) {
    const scheduled: Array<{ ms: number; name: string; args: any }> = [];
    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return campaign;
                default:
                    return undefined;
            }
        }),
        scheduler: {
            runAfter: vi.fn(async (ms: number, ref: unknown, args: any) => {
                scheduled.push({ ms, name: getFunctionName(ref as any), args });
            }),
        },
    };
    return { ctx, scheduled };
}

describe("scheduleSendAfterOptionalPregen", () => {
    it("gates an upload campaign behind pre-generation, passing the channel through", async () => {
        const { ctx, scheduled } = createCtx({
            _id: "c1",
            columnRoles: { trackingKey: "Ref", invoiceGuid: "InvoiceGuid" },
        });

        await scheduleSendAfterOptionalPregen(ctx as any, "c1" as any, "email");

        // The send is NOT scheduled directly; the pre-gen job is, and it carries the
        // send channel so it can kick the batch processor once every PDF is settled.
        expect(scheduled).toEqual([
            {
                ms: 0,
                name: "invoicePdfs:pregenerateCampaignInvoicePdfs",
                args: { campaignId: "c1", sendChannel: "email" },
            },
        ]);
    });

    it("carries the WhatsApp channel through the gate for an upload WhatsApp campaign", async () => {
        const { ctx, scheduled } = createCtx({
            _id: "c1",
            columnRoles: { trackingKey: "Ref", invoiceGuid: "InvoiceGuid" },
        });

        await scheduleSendAfterOptionalPregen(ctx as any, "c1" as any, "whatsapp");

        expect(scheduled).toEqual([
            {
                ms: 0,
                name: "invoicePdfs:pregenerateCampaignInvoicePdfs",
                args: { campaignId: "c1", sendChannel: "whatsapp" },
            },
        ]);
    });

    it("sends directly when no invoice-GUID column is designated (upload without PDFs)", async () => {
        const { ctx, scheduled } = createCtx({
            _id: "c1",
            columnRoles: { trackingKey: "Ref" }, // sendAddress/invoiceGuid unset
        });

        await scheduleSendAfterOptionalPregen(ctx as any, "c1" as any, "email");

        expect(scheduled).toEqual([
            { ms: 0, name: "campaignQueue:processEmailBatch", args: { campaignId: "c1" } },
        ]);
    });

    it("sends directly for a non-upload campaign (no columnRoles at all)", async () => {
        const { ctx, scheduled } = createCtx({ _id: "c1" });

        await scheduleSendAfterOptionalPregen(ctx as any, "c1" as any, "whatsapp");

        expect(scheduled).toEqual([
            { ms: 0, name: "campaignQueue:processWhatsAppBatch", args: { campaignId: "c1" } },
        ]);
    });

    it("treats a blank/whitespace invoice-GUID column as no PDFs and sends directly", async () => {
        const { ctx, scheduled } = createCtx({
            _id: "c1",
            columnRoles: { trackingKey: "Ref", invoiceGuid: "   " },
        });

        await scheduleSendAfterOptionalPregen(ctx as any, "c1" as any, "email");

        expect(scheduled).toEqual([
            { ms: 0, name: "campaignQueue:processEmailBatch", args: { campaignId: "c1" } },
        ]);
    });
});
