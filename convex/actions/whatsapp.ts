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
    type MetaWhatsAppConfig,
    type TemplateLike,
} from "../lib/whatsapp";
import { notifyTinaOfOutboundTemplate, substitutedBodyVariables } from "../lib/notifyTina";

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

        // Seed Tina's history with the test send too, so replying to a test
        // template behaves identically to replying to a campaign send. Awaited
        // best-effort; never throws.
        await notifyTinaOfOutboundTemplate({
            phone: toDigits,
            templateName: template.name,
            templateLanguage: template.language,
            templateVariables: substitutedBodyVariables(templateForSend.variables, allVariables),
            senderMessageId: result.wamid,
            sender: "manual_test",
        });

        return {
            success: true,
            messageSid: result.wamid,
            status: "accepted",
        };
    },
});
