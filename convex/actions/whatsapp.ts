"use node";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

import { getClickatellConfig, uploadClickatellMedia, ClickatellResponse } from "../lib/whatsapp";

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
        const config = getClickatellConfig();

        // Get template details
        const template: Doc<"whatsappTemplates"> | null = await ctx.runQuery(api.whatsappTemplates.getById, {
            id: args.templateId,
        });

        if (!template) {
            throw new Error("Template not found");
        }

        // Format phone number (remove + and spaces for Clickatell if needed, but usually E.164 is fine without + or with it. 
        const toNumber = args.phoneNumber.replace(/\D/g, "");
        if (toNumber.startsWith("0")) {
            console.warn(`WARNING: Phone number ${toNumber} starts with 0. Clickatell requires international format (e.g., 27... or 44...). Messages may fail.`);
        }

        // Prepare Header (Upload if needed)
        // Clickatell requires uploading the media first to get a fileId
        // Clickatell One API Payload (Simplified)
        // We revert to this structure because the HSM/components structure caused a 400 Malformed error.
        // The previous issue (media not delivering) was likely due to the fileId being .unsupported, which is now fixed in lib/whatsapp.ts.

        let headerPayload: any = undefined;

        if (template.headerType && template.headerType !== "none") {
            if (template.headerType === "text" && template.headerText) {
                headerPayload = {
                    type: "text",
                    text: template.headerText
                };
            } else if (["image", "document", "video"].includes(template.headerType) && template.headerUrl) {
                try {
                    const fileName = template.headerUrl.split('/').pop() || "media_file";
                    const fileId = await uploadClickatellMedia(config.apiKey, template.headerUrl, toNumber, fileName);

                    // For Simplified API, we usually use 'media' type for all files
                    // The file extension (added in lib/whatsapp.ts) determines the actual type for WhatsApp
                    headerPayload = {
                        type: "media",
                        media: { fileId }
                    };
                } catch (e) {
                    console.error("Failed to upload header media:", e);
                    throw new Error(`Header media upload failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        // Map variables to a simple map
        const parameters: Record<string, string> = {};
        template.variables.forEach(varName => {
            parameters[varName] = args.variables[varName] || "";
        });

        const templatePayload: any = {
            templateName: template.name,
            body: {
                parameters: parameters
            }
        };

        if (headerPayload) {
            templatePayload.header = headerPayload;
        }

        const payload = {
            messages: [
                {
                    channel: "whatsapp",
                    to: toNumber,
                    template: templatePayload
                }
            ]
        };

        console.log("=== CLICKATELL DEBUG ===");
        console.log("Template:", template.name);
        console.log("Header Type:", template.headerType);
        console.log("Header Payload:", JSON.stringify(headerPayload, null, 2));
        console.log("CLICKATELL PAYLOAD:", JSON.stringify(payload, null, 2));
        console.log("========================");

        const response: Response = await fetch(
            "https://platform.clickatell.com/v1/message",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": config.apiKey,
                },
                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Clickatell API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result: ClickatellResponse = await response.json();
        console.log("CLICKATELL RESPONSE:", JSON.stringify(result, null, 2));

        // Check first message status
        const msgResult = result.messages[0];

        if (!msgResult.accepted) {
            throw new Error(`Clickatell message rejected: ${JSON.stringify(msgResult.error)}`);
        }

        return {
            success: true,
            messageSid: msgResult.apiMessageId,
            status: "queued", // Clickatell returns "accepted"
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
        const config = getClickatellConfig();

        // Get template details
        const template: Doc<"whatsappTemplates"> | null = await ctx.runQuery(api.whatsappTemplates.getById, {
            id: args.templateId,
        });

        if (!template) {
            throw new Error("Template not found");
        }

        // Pre-process Header Media (Upload ONCE for the whole batch)
        let headerPayload: any = undefined;
        if (template.headerType && template.headerType !== "none") {
            if (template.headerType === "text" && template.headerText) {
                headerPayload = {
                    type: "text",
                    text: template.headerText
                };
            } else if (["image", "document", "video"].includes(template.headerType) && template.headerUrl) {
                try {
                    console.log("Uploading bulk campaign header media...");
                    const fileName = template.headerUrl.split('/').pop() || "media_file";
                    // Use the first recipient's phone number for the upload
                    // Assumption: The fileId can be reused for other recipients (now that payload structure is fixed)
                    const firstRecipientPhone = args.recipients[0]?.phoneNumber || "";
                    if (!firstRecipientPhone) {
                        throw new Error("No recipients available to upload media");
                    }
                    const toNumber = firstRecipientPhone.replace(/\D/g, "");
                    const fileId = await uploadClickatellMedia(config.apiKey, template.headerUrl, toNumber, fileName, true);

                    headerPayload = {
                        type: "media",
                        media: { fileId }
                    };
                    console.log("Bulk campaign media uploaded. File ID:", fileId);
                } catch (e) {
                    console.error("Failed to upload bulk header media:", e);
                    throw new Error(`Bulk header media upload failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        const results: {
            total: number;
            success: number;
            failed: number;
            details: Array<{
                recipientId: string;
                success: boolean;
                messageSid?: string;
                error?: string;
            }>;
        } = {
            total: args.recipients.length,
            success: 0,
            failed: 0,
            details: [],
        };

        // Clickatell supports batching in the "messages" array.
        // We can increase batch size back to 50 since we aren't doing heavy uploads per row.
        const batchSize = 50;

        for (let i = 0; i < args.recipients.length; i += batchSize) {
            const batchRecipients = args.recipients.slice(i, i + batchSize);

            // Construct messages array for this batch
            const messagesPayload = batchRecipients.map(recipient => {
                const toNumber = recipient.phoneNumber.replace(/\D/g, "");
                if (toNumber.startsWith("0")) {
                    console.warn(`WARNING: Phone number ${toNumber} starts with 0. Clickatell requires international format. Messages may fail.`);
                }

                // Auto-fill common variables and map to template parameters
                const allVariables: Record<string, string> = {
                    name: recipient.name,
                    fullname: recipient.name,
                    first_name: recipient.name.split(" ")[0],
                    firstname: recipient.name.split(" ")[0],
                    mobilephone: recipient.phoneNumber,
                    ...recipient.variables,
                };

                const parameters: Record<string, string> = {};
                template.variables.forEach(varName => {
                    parameters[varName] = allVariables[varName] || "";
                });

                // Build template payload (Simplified API to match sendTestWhatsApp)
                const templatePayload: any = {
                    templateName: template.name,
                    body: {
                        parameters: parameters
                    }
                };

                if (headerPayload) {
                    templatePayload.header = headerPayload;
                }

                return {
                    channel: "whatsapp",
                    to: toNumber,
                    template: templatePayload
                };
            });

            console.log("CLICKATELL BULK PAYLOAD (Batch):", JSON.stringify({ messages: messagesPayload }, null, 2));

            try {
                const response: Response = await fetch(
                    "https://platform.clickatell.com/v1/message",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": config.apiKey,
                        },
                        body: JSON.stringify({ messages: messagesPayload }),
                    }
                );

                if (!response.ok) {
                    const errorText = await response.text();
                    // If batch fails, mark all as failed
                    // Or parse individual errors if partial success is returned (depends on API)
                    // Usually 202 Accepted is returned with a list of results.
                    throw new Error(`Clickatell API Batch Error: ${response.statusText} - ${errorText}`);
                }

                const result: ClickatellResponse = await response.json();
                console.log("CLICKATELL BATCH RESPONSE:", JSON.stringify(result, null, 2));

                // Map results back to recipients
                // Assuming result.messages order matches request messages order OR we use clientMessageId
                // Clickatell returns `apiMessageId`, `accepted`, `to`, `clientMessageId` (if sent)

                // Create a map of clientMessageId to result for easy lookup
                const resultMap = new Map(result.messages.map(msg => [msg.apiMessageId /* Note: Clickatell might not return clientMessageId in response msg object immediately, need to check docs. Assuming order is preserved or simple match for now. */, msg]));

                // Actually, Clickatell "accepted" response is usually an array matching the input.
                // Let's assume order matches for now, as it's standard for batch APIs.

                result.messages.forEach((msg, index) => {
                    const recipient = batchRecipients[index];
                    // Ideally we match by 'to' number if order isn't guaranteed, but sanitization makes it tricky.
                    // Let's trust index mapping for this implementation or just iterate.

                    if (msg.accepted) {
                        results.success++;
                        results.details.push({
                            recipientId: recipient.id,
                            success: true,
                            messageSid: msg.apiMessageId
                        });
                    } else {
                        results.failed++;
                        results.details.push({
                            recipientId: recipient.id,
                            success: false,
                            error: JSON.stringify(msg.error)
                        });
                    }
                });

            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Unknown batch error";
                // Mark all in this batch as failed
                batchRecipients.forEach(r => {
                    results.failed++;
                    results.details.push({
                        recipientId: r.id,
                        success: false,
                        error: errorMessage
                    });
                });
            }

            // Small delay between batches
            if (i + batchSize < args.recipients.length) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }

        // Update individual message statuses if campaignId is present
        if (args.campaignId) {
            for (const detail of results.details) {
                await ctx.runMutation(internal.messages.updateStatusByRecipient, {
                    campaignId: args.campaignId,
                    recipientId: detail.recipientId,
                    status: detail.success ? "sent" : "failed",
                    sentAt: Date.now(),
                    errorMessage: detail.error,
                    externalMessageId: detail.messageSid,
                });
            }
        }

        return {
            summary: {
                total: results.total,
                success: results.success,
                failed: results.failed,
            },
            details: results.details,
        };
    },
});

// Query status of a message
export const getWhatsAppStatus = action({
    args: {
        messageSid: v.string(),
    },
    returns: v.any(),
    handler: async (ctx, args) => {
        const config = getClickatellConfig();

        console.log(`Checking status for message: ${args.messageSid}`);

        const response = await fetch(
            `https://platform.clickatell.com/v1/message/${args.messageSid}`,
            {
                method: "GET",
                headers: {
                    "Authorization": config.apiKey,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Clickatell Status API Error: ${response.status} - ${errorText}`);
            throw new Error(`Clickatell API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json();
        console.log("CLICKATELL STATUS RESPONSE:", JSON.stringify(result, null, 2));

        return result;
    },
});
