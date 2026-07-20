import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { checkAccessHelper } from "./users";
import { generateInvoicePdf } from "./lib/invoiceGenerator";
import { pregenInvoicePdfs, type PregenItem } from "./lib/invoicePdfPregen";
import type { PdfStatus } from "../src/components/recipients/validationReport";

/**
 * Per-recipient invoice-PDF pre-generation (PRD `prd-bad-debt-excel-campaign.md`,
 * issue #68). Ahead of a send, each recipient's invoice PDF is generated from the
 * invoice-GUID column, stored in Convex storage, and its terminal status recorded
 * here — so a generation failure surfaces in the pre-send validation gate (#67)
 * rather than breaking a live send.
 *
 * The pure decision logic lives in `lib/invoicePdfPregen.ts` (bounded-concurrency
 * orchestration) and `lib/invoiceGenerator.ts` (the Azure boundary); this module is
 * the impure glue — mutations/queries over the `invoicePdfs` table plus the chunked,
 * self-rescheduling background action that composes them with real storage + client,
 * mirroring the campaign batch/queue worker pattern.
 */

/** Recipients per background-action invocation before it reschedules itself. */
export const PREGEN_CHUNK_SIZE = 25;
/**
 * Max concurrent generations in flight within a chunk. Held to ~6 because the
 * bottleneck is Dataverse service-protection throttling (the function itself
 * renders in ~25 ms), not the function — fanning out wider just trips 429s.
 */
export const PREGEN_CONCURRENCY = 6;

/**
 * Upsert one recipient's terminal PDF status, keyed by `(campaignId, recipientId)`.
 * `generated` carries the `storageId` and clears any prior error; `failed` carries
 * the error and clears the `storageId`. Idempotent — a re-run patches the same row.
 */
export const recordPdfStatus = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        recipientId: v.string(),
        invoiceGuid: v.string(),
        status: v.string(),
        storageId: v.optional(v.id("_storage")),
        invoiceType: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign_recipient", (q) =>
                q.eq("campaignId", args.campaignId).eq("recipientId", args.recipientId),
            )
            .unique();

        const doc = {
            campaignId: args.campaignId,
            recipientId: args.recipientId,
            invoiceGuid: args.invoiceGuid,
            status: args.status,
            storageId: args.status === "generated" ? args.storageId : undefined,
            invoiceType: args.invoiceType,
            errorMessage: args.status === "failed" ? args.errorMessage : undefined,
        };

        if (existing) {
            await ctx.db.patch(existing._id, doc);
        } else {
            await ctx.db.insert("invoicePdfs", doc);
        }
    },
});

/**
 * Seed a `pending` (or `failed`, for a blank/absent GUID) row for every recipient
 * that does not already have one, resolving each recipient's invoice GUID from its
 * variables bag by the campaign's designated invoice-GUID header. Idempotent:
 * recipients already recorded are skipped, so a recovery re-run never duplicates or
 * regresses a settled row. Returns the campaign's total recipient count and how many
 * new rows were seeded. A campaign with no invoice-GUID role seeds nothing (no PDFs).
 */
export const seedPendingForCampaign = internalMutation({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const campaign = await ctx.db.get(args.campaignId);
        const invoiceGuidHeader = campaign?.columnRoles?.invoiceGuid?.trim();
        if (!invoiceGuidHeader) return { total: 0, seeded: 0 };

        const batches = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        const existing = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();
        const seen = new Set(existing.map((r) => r.recipientId));

        let total = 0;
        let seeded = 0;
        for (const batch of batches) {
            for (const recipient of batch.recipients) {
                total++;
                if (seen.has(recipient.id)) continue;
                seen.add(recipient.id);

                const invoiceGuid = resolveInvoiceGuid(recipient.variables, invoiceGuidHeader);
                if (invoiceGuid === "") {
                    // No GUID to generate from — record failed so the gate holds the row.
                    await ctx.db.insert("invoicePdfs", {
                        campaignId: args.campaignId,
                        recipientId: recipient.id,
                        invoiceGuid: "",
                        status: "failed",
                        errorMessage: `No value for invoice-GUID column "${invoiceGuidHeader}"`,
                    });
                } else {
                    await ctx.db.insert("invoicePdfs", {
                        campaignId: args.campaignId,
                        recipientId: recipient.id,
                        invoiceGuid,
                        status: "pending",
                    });
                }
                seeded++;
            }
        }
        return { total, seeded };
    },
});

/** Read the invoice-GUID cell (trimmed) from a recipient's JSON variables bag. */
function resolveInvoiceGuid(variables: string | undefined, header: string): string {
    if (!variables) return "";
    try {
        const bag = JSON.parse(variables) as Record<string, unknown>;
        const value = bag[header];
        return typeof value === "string" ? value.trim() : "";
    } catch {
        return "";
    }
}

/** A chunk of recipients still awaiting generation (status `pending`), oldest first. */
export const getPendingChunk = internalQuery({
    args: { campaignId: v.id("campaigns"), limit: v.number() },
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", args.campaignId).eq("status", "pending"),
            )
            .take(args.limit);
        return rows.map((r) => ({
            recipientId: r.recipientId,
            invoiceGuid: r.invoiceGuid,
            type: r.invoiceType,
        }));
    },
});

/** Count of recipients still `pending` — used to decide whether to reschedule. */
export const getPendingCount = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", args.campaignId).eq("status", "pending"),
            )
            .collect();
        return rows.length;
    },
});

/**
 * The per-recipient PDF status map (`recipientId → status`) the pre-send validation
 * gate (#67) consumes. A recipient absent from this map is treated by the gate as
 * the trivially-passing `generated` sentinel, so only recorded rows can hold a send.
 */
export const getPdfStatusMap = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args): Promise<Record<string, PdfStatus>> => {
        const rows = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();
        const map: Record<string, PdfStatus> = {};
        for (const r of rows) map[r.recipientId] = r.status as PdfStatus;
        return map;
    },
});

/**
 * Pre-generation progress for the operator's indicator: how many recipients are
 * pending / generated / failed, and the total. Auth-checked so the UI can poll it.
 */
export const getPregenProgress = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        const rows = await ctx.db
            .query("invoicePdfs")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        const progress = { pending: 0, generated: 0, failed: 0, total: rows.length };
        for (const r of rows) {
            if (r.status === "generated") progress.generated++;
            else if (r.status === "failed") progress.failed++;
            else progress.pending++;
        }
        return progress;
    },
});

/**
 * Chunked, self-rescheduling background job that pre-generates every recipient's
 * invoice PDF. On first entry it seeds a row per recipient; each invocation then
 * claims one {@link PREGEN_CHUNK_SIZE} chunk of pending rows, runs them through the
 * bounded-concurrency orchestrator (real Azure client + `ctx.storage.store` +
 * {@link recordPdfStatus}), and reschedules itself while any remain — the same
 * batch/queue shape the send workers use, so a long run stays inside the action
 * time limit and progress is durable across invocations.
 */
export const pregenerateCampaignInvoicePdfs = internalAction({
    args: { campaignId: v.id("campaigns"), seeded: v.optional(v.boolean()) },
    handler: async (ctx, args) => {
        if (!args.seeded) {
            await ctx.runMutation(internal.invoicePdfs.seedPendingForCampaign, {
                campaignId: args.campaignId,
            });
        }

        const chunk = await ctx.runQuery(internal.invoicePdfs.getPendingChunk, {
            campaignId: args.campaignId,
            limit: PREGEN_CHUNK_SIZE,
        });
        if (chunk.length === 0) return;

        await pregenInvoicePdfs(chunk as PregenItem[], {
            concurrency: PREGEN_CONCURRENCY,
            fetchPdf: async (item) => {
                const result = await generateInvoicePdf({
                    invoiceId: item.invoiceGuid,
                    type: item.type === "Tax" || item.type === "Accounting" ? item.type : undefined,
                });
                if (!result.success) throw new Error(result.error);
                return result.bytes;
            },
            store: async (bytes) =>
                await ctx.storage.store(new Blob([bytes], { type: "application/pdf" })),
            record: async (outcome) => {
                await ctx.runMutation(internal.invoicePdfs.recordPdfStatus, {
                    campaignId: args.campaignId,
                    recipientId: outcome.recipientId,
                    invoiceGuid: outcome.invoiceGuid,
                    status: outcome.status,
                    storageId:
                        outcome.status === "generated"
                            ? (outcome.storageId as Id<"_storage">)
                            : undefined,
                    errorMessage: outcome.status === "failed" ? outcome.error : undefined,
                });
            },
        });

        const remaining = await ctx.runQuery(internal.invoicePdfs.getPendingCount, {
            campaignId: args.campaignId,
        });
        if (remaining > 0) {
            await ctx.scheduler.runAfter(0, internal.invoicePdfs.pregenerateCampaignInvoicePdfs, {
                campaignId: args.campaignId,
                seeded: true,
            });
        }
    },
});
