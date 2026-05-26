"use node";
import { v, ConvexError } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

import {
    getMetaWhatsAppConfig,
    normalizeToE164Digits,
    buildTemplateRequestBody,
    sendTemplateWithRetry,
    isTemplatePermanentError,
    isMediaHeaderType,
    shouldRefreshMediaId,
    uploadWhatsAppMedia,
    RateLimiter,
    type MetaSendResult,
    type MetaWhatsAppConfig,
    type TemplateLike,
} from "../lib/whatsapp";

/**
 * Decide whether the template needs a fresh media-id upload and, if so, run
 * the upload. Returns either the cached id from the template doc or the
 * newly-uploaded one, plus a flag telling the caller to persist the cache.
 *
 * Kept ctx-free so the same helper works in any action runtime — the caller
 * persists via runMutation with its own properly-typed ctx.
 */
async function resolveHeaderMediaId(
    config: MetaWhatsAppConfig,
    template: Doc<"whatsappTemplates">
): Promise<{ mediaId: string | undefined; toPersist: { mediaId: string; mimeType: string; sourceUrl: string } | null }> {
    if (!isMediaHeaderType(template.headerType) || !template.headerUrl) {
        return { mediaId: undefined, toPersist: null };
    }

    const needsRefresh = shouldRefreshMediaId(
        {
            headerMediaId: template.headerMediaId,
            headerMediaIdUploadedAt: template.headerMediaIdUploadedAt,
            headerMediaSourceUrl: template.headerMediaSourceUrl,
        },
        template.headerUrl
    );

    if (!needsRefresh && template.headerMediaId) {
        return { mediaId: template.headerMediaId, toPersist: null };
    }

    const upload = await uploadWhatsAppMedia(config, {
        sourceUrl: template.headerUrl,
        headerType: template.headerType,
        mimeTypeOverride: template.headerMediaMimeType,
    });

    return {
        mediaId: upload.mediaId,
        toPersist: { mediaId: upload.mediaId, mimeType: upload.mimeType, sourceUrl: template.headerUrl },
    };
}

// Send a single test WhatsApp message
export const sendTestWhatsApp = action({
    args: {
        phoneNumber: v.string(),
        templateId: v.id("whatsappTemplates"),
        variables: v.record(v.string(), v.string()),
    },
    returns: v.object({
        success: v.boolean(),
        messageSid: v.string(),
        status: v.string(),
    }),
    handler: async (ctx, args): Promise<{ success: boolean; messageSid: string; status: string }> => {
        const config = getMetaWhatsAppConfig();

        const template: Doc<"whatsappTemplates"> | null = await ctx.runQuery(api.whatsappTemplates.getById, {
            id: args.templateId,
        });

        if (!template) {
            throw new Error("Template not found");
        }

        const toDigits = normalizeToE164Digits(args.phoneNumber);
        if (!toDigits) {
            throw new ConvexError(`Invalid phone number: ${args.phoneNumber}`);
        }

        // Pass the caller's full variables map; the payload builder picks
        // body variables (from template.variables) and the button variable
        // (from template.buttonUrlVariable) out of it directly.
        const allVariables: Record<string, string> = { ...args.variables };

        const { mediaId, toPersist } = await resolveHeaderMediaId(config, template);
        if (toPersist) {
            await ctx.runMutation(internal.whatsappTemplates.setHeaderMediaCache, {
                id: template._id,
                ...toPersist,
            });
        }

        const templateForSend: TemplateLike = { ...(template as TemplateLike), headerMediaId: mediaId };
        const body = buildTemplateRequestBody(templateForSend, toDigits, allVariables);
        const result = await sendTemplateWithRetry(config, body);

        if (result.status === "failed") {
            if (isTemplatePermanentError(result.errorCode)) {
                throw new ConvexError(
                    `WhatsApp template '${template.name}' (lang ${template.language}) is paused, misnamed, or has a variable mismatch. ` +
                        `Meta error ${result.errorCode}: ${result.errorMessage}`
                );
            }
            throw new ConvexError(
                `Meta WhatsApp send failed (code ${result.errorCode ?? "n/a"}, ${result.attempts} attempts): ${result.errorMessage}`
            );
        }

        return {
            success: true,
            messageSid: result.wamid,
            status: "accepted",
        };
    },
});

// Send bulk WhatsApp messages
export const sendBulkWhatsApp = action({
    args: {
        recipients: v.array(
            v.object({
                id: v.string(),
                phoneNumber: v.string(),
                name: v.string(),
                variables: v.record(v.string(), v.string()),
            })
        ),
        templateId: v.id("whatsappTemplates"),
        createDynamicsActivity: v.boolean(),
        campaignId: v.optional(v.id("campaigns")),
    },
    returns: v.object({
        summary: v.object({
            total: v.number(),
            success: v.number(),
            failed: v.number(),
        }),
        details: v.array(
            v.object({
                recipientId: v.string(),
                success: v.boolean(),
                messageSid: v.optional(v.string()),
                error: v.optional(v.string()),
            })
        ),
    }),
    handler: async (ctx, args) => {
        const config = getMetaWhatsAppConfig();

        const template: Doc<"whatsappTemplates"> | null = await ctx.runQuery(api.whatsappTemplates.getById, {
            id: args.templateId,
        });

        if (!template) {
            throw new Error("Template not found");
        }

        if (args.recipients.length > config.dailyTierLimit) {
            throw new ConvexError(
                `Recipient count (${args.recipients.length}) exceeds Meta daily tier limit (${config.dailyTierLimit}). ` +
                    `Lower the list size or raise META_DAILY_TIER_LIMIT once a higher tier is approved.`
            );
        }

        // Upload header media to Meta once per campaign before fanning out — every
        // recipient then references the same media id rather than asking Meta to
        // re-fetch the source URL N times.
        const { mediaId: bulkMediaId, toPersist: bulkPersist } = await resolveHeaderMediaId(config, template);
        if (bulkPersist) {
            await ctx.runMutation(internal.whatsappTemplates.setHeaderMediaCache, {
                id: template._id,
                ...bulkPersist,
            });
        }
        const templateForSend: TemplateLike = { ...(template as TemplateLike), headerMediaId: bulkMediaId };

        const limiter = new RateLimiter(config.maxSendPerSecond, config.maxConcurrent);
        const details: Array<{ recipientId: string; success: boolean; messageSid?: string; error?: string }> = [];
        let successCount = 0;
        let failedCount = 0;

        await Promise.all(
            args.recipients.map(async (recipient) => {
                const toDigits = normalizeToE164Digits(recipient.phoneNumber);
                if (!toDigits) {
                    failedCount++;
                    details.push({
                        recipientId: recipient.id,
                        success: false,
                        error: `Invalid phone number: ${recipient.phoneNumber}`,
                    });
                    return;
                }

                const allVariables: Record<string, string> = {
                    name: recipient.name,
                    fullname: recipient.name,
                    first_name: recipient.name.split(" ")[0],
                    firstname: recipient.name.split(" ")[0],
                    mobilephone: recipient.phoneNumber,
                    ...recipient.variables,
                };

                const body = buildTemplateRequestBody(templateForSend, toDigits, allVariables);
                const result: MetaSendResult = await limiter.schedule(() => sendTemplateWithRetry(config, body));

                if (result.status === "sent") {
                    successCount++;
                    details.push({
                        recipientId: recipient.id,
                        success: true,
                        messageSid: result.wamid,
                    });
                } else {
                    failedCount++;
                    details.push({
                        recipientId: recipient.id,
                        success: false,
                        error: `code=${result.errorCode ?? "n/a"} ${result.errorMessage}`,
                    });
                }
            })
        );

        if (args.campaignId && details.length > 0) {
            await ctx.runMutation(internal.messages.updateStatusBatch, {
                campaignId: args.campaignId,
                updates: details.map((d) => ({
                    recipientId: d.recipientId,
                    status: d.success ? "sent" : "failed",
                    sentAt: Date.now(),
                    errorMessage: d.error,
                    externalMessageId: d.messageSid,
                })),
            });
        }

        return {
            summary: {
                total: args.recipients.length,
                success: successCount,
                failed: failedCount,
            },
            details,
        };
    },
});
