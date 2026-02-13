"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { sendEmail, type EmailAttachment } from "../lib/graph_client";
import { dynamicsRequest } from "../lib/dynamics_auth";
import { internal } from "../_generated/api";
import { wrapEmail } from "../lib/emailLayout";

/**
 * Send a single email via Microsoft Graph
 */
export const sendSingleEmail = action({
    args: {
        to: v.object({
            email: v.string(),
            name: v.optional(v.string()),
        }),
        subject: v.string(),
        htmlBody: v.string(),
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    contentBase64: v.string(),
                    isInline: v.optional(v.boolean()),
                })
            )
        ),
    },
    handler: async (ctx, args) => {
        const result = await sendEmail({
            subject: args.subject,
            body: wrapEmail(args.htmlBody, args.subject),
            toRecipients: [args.to],
            attachments: args.attachments as EmailAttachment[] | undefined,
        });

        return result;
    },
});

/**
 * Send a test email to verify configuration
 */
export const sendTestEmail = action({
    args: {
        testEmailAddress: v.string(),
        subject: v.string(),
        htmlBody: v.string(),
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    contentBase64: v.string(),
                    isInline: v.optional(v.boolean()),
                })
            )
        ),
        fromMailbox: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const result = await sendEmail({
            subject: `[TEST] ${args.subject}`,
            body: wrapEmail(`
        <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 16px; margin-bottom: 20px; border-radius: 8px;">
          <strong>⚠️ This is a test email</strong><br/>
          <small>This email was sent as a test before launching the campaign.</small>
        </div>
        ${args.htmlBody}
      `, `[TEST] ${args.subject}`),
            toRecipients: [{ email: args.testEmailAddress }],
            attachments: args.attachments as EmailAttachment[] | undefined,
            fromMailbox: args.fromMailbox,
        });

        return result;
    },
});

/**
 * Send bulk emails to a list of recipients
 * Returns results for each recipient
 */
export const sendBulkEmails = action({
    args: {
        recipients: v.array(
            v.object({
                id: v.string(), // Dynamics contact ID
                email: v.string(),
                name: v.string(),
            })
        ),
        subject: v.string(),
        htmlBody: v.string(),
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    contentBase64: v.string(),
                    isInline: v.optional(v.boolean()),
                })
            )
        ),
        createDynamicsActivity: v.optional(v.boolean()),
        campaignId: v.optional(v.id("campaigns")),
        fromMailbox: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const results: Array<{
            recipientId: string;
            email: string;
            success: boolean;
            error?: string;
            dynamicsActivityId?: string;
        }> = [];

        // 1. Create message records if campaignId is provided
        if (args.campaignId) {
            await ctx.runMutation(internal.messages.createBatch, {
                messages: args.recipients.map((r) => ({
                    campaignId: args.campaignId!,
                    recipientId: r.id,
                    recipientEmail: r.email,
                    recipientName: r.name,
                    status: "pending",
                    channel: "email" as const,
                })),
            });
        }

        // Process emails with rate limiting (10 per second)
        for (const recipient of args.recipients) {
            try {
                const result = await sendEmail({
                    subject: args.subject,
                    body: wrapEmail(args.htmlBody, args.subject),
                    toRecipients: [{ email: recipient.email, name: recipient.name }],
                    attachments: args.attachments as EmailAttachment[] | undefined,
                    fromMailbox: args.fromMailbox,
                });

                let dynamicsActivityId: string | undefined;

                // Create activity in Dynamics if requested
                if (result.success && args.createDynamicsActivity) {
                    try {
                        dynamicsActivityId = await createEmailActivity(
                            recipient.id,
                            recipient.email,
                            args.subject,
                            args.htmlBody
                        );
                    } catch (err) {
                        console.error("Failed to create Dynamics activity:", err);
                    }
                }

                results.push({
                    recipientId: recipient.id,
                    email: recipient.email,
                    success: result.success,
                    error: result.error,
                    dynamicsActivityId,
                });

                // Update individual message status if campaignId is present
                if (args.campaignId) {
                    await ctx.runMutation(internal.messages.updateStatusByRecipient, {
                        campaignId: args.campaignId,
                        recipientId: recipient.id,
                        status: result.success ? "sent" : "failed",
                        sentAt: Date.now(),
                        errorMessage: result.error,
                    });
                }

                // Rate limiting: 100ms between emails (10/sec)
                await new Promise((resolve) => setTimeout(resolve, 100));
            } catch (err) {
                results.push({
                    recipientId: recipient.id,
                    email: recipient.email,
                    success: false,
                    error: err instanceof Error ? err.message : "Unknown error",
                });
            }
        }

        const successCount = results.filter((r) => r.success).length;
        const failedCount = results.filter((r) => !r.success).length;

        // Update campaign status and stats
        if (args.campaignId) {
            await ctx.runMutation(internal.campaigns.updateStats, {
                campaignId: args.campaignId,
                sentCount: successCount + failedCount,
                deliveredCount: successCount,
                failedCount: failedCount,
            });

            await ctx.runMutation(internal.campaigns.updateStatus, {
                campaignId: args.campaignId,
                status: "completed",
            });
        }

        return {
            results,
            summary: {
                total: results.length,
                success: successCount,
                failed: failedCount,
            },
        };
    },
});

/**
 * Create an email activity record in Dynamics 365
 */
async function createEmailActivity(
    contactId: string,
    toEmail: string,
    subject: string,
    body: string
): Promise<string> {
    const dynamicsUrl = process.env.DYNAMICS_ORG_URL;
    const sharedMailbox = process.env.SHARED_MAILBOX_ADDRESS;

    if (!dynamicsUrl || !sharedMailbox) {
        throw new Error("Dynamics or mailbox not configured");
    }

    // Create email activity
    const emailActivity = {
        subject: subject,
        description: body.replace(/<[^>]*>/g, "").substring(0, 2000), // Strip HTML, limit length
        directioncode: true, // Outgoing
        "regardingobjectid_contact@odata.bind": `/contacts(${contactId})`,
        actualdurationminutes: 1,
        statuscode: 2, // Sent
        statecode: 1, // Completed
    };

    const response = await dynamicsRequest<{ emailid: string }>("emails", {
        method: "POST",
        body: JSON.stringify(emailActivity),
    });

    return response.emailid;
}

/**
 * Get the configured shared mailbox address
 */
export const getSharedMailbox = action({
    args: {},
    handler: async () => {
        const mailbox = process.env.SHARED_MAILBOX_ADDRESS;
        return {
            configured: !!mailbox,
            address: mailbox ? mailbox.replace(/^(.{3}).*(@.*)$/, "$1***$2") : null, // Mask for security
        };
    },
});

/**
 * Send an invitation email to a new user
 */
export const sendInvitationEmail = internalAction({
    args: {
        email: v.string(),
        token: v.string(),
        role: v.string(),
        invitedBy: v.string(),
    },
    handler: async (ctx, args) => {
        const inviteLink = `${process.env.SITE_URL || "http://localhost:3000"}/accept-invite?token=${args.token}`;

        const htmlBody = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>You've been invited to join the TTT Communication Tool</h2>
            <p>Hello,</p>
            <p>You have been invited by <strong>${args.invitedBy}</strong> to join the TTT Communication Tool as a <strong>${args.role}</strong>.</p>
            <p>To accept this invitation and get started, please click the button below:</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${inviteLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Accept Invitation</a>
            </div>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
            <p style="color: #666; font-size: 12px;">This invitation was sent from the TTT Communication Tool. If you were not expecting this, please ignore this email.</p>
        </div>
        `;

        const result = await sendEmail({
            subject: "Invitation to TTT Communication Tool",
            body: wrapEmail(htmlBody, "Invitation to TTT Communication Tool"),
            toRecipients: [{ email: args.email }],
            fromMailbox: "no-reply@ttt-group.co.za",
        });

        return result;
    },
});
