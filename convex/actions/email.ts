"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { sendEmail, type EmailAttachment } from "../lib/graph_client";
import { internal, api } from "../_generated/api";
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
                    contentId: v.optional(v.string()),
                })
            )
        ),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
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
                    contentId: v.optional(v.string()), // Explicit contentId support
                })
            )
        ),
        fromMailbox: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthenticated");

        if (args.fromMailbox) {
            const user = await ctx.runQuery(internal.users.getCurrentUserInternal, { clerkId: identity.subject });

            if (!user) throw new Error("User not found");

            if (user.role !== "admin" && args.fromMailbox.toLowerCase() !== user.email.toLowerCase()) {
                throw new Error("Unauthorized: You can only test emails using your own email address.");
            }
        }

        const result = await sendEmail({
            subject: `[TEST] ${args.subject}`,
            body: wrapEmail(`
        <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 12px 16px; margin-bottom: 12px; border-radius: 8px;">
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
 * Get the configured shared mailbox address
 */
export const getSharedMailbox = action({
    args: {},
    handler: async (ctx) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
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
