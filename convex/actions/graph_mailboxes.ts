"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { getGraphAccessToken } from "../lib/graph_client";
import { internal } from "../_generated/api";

interface MailboxInfo {
    id: string;
    displayName: string;
    mail: string;
}

/**
 * Get available shared mailboxes the application can send from.
 * This queries mailboxes configured in environment variables.
 * 
 * Note: To dynamically discover shared mailboxes via Graph API,
 * the app would need Mail.Read.Shared or Organization.Read.All permissions.
 * For simplicity, we use a comma-separated list from env vars.
 */
export const getAvailableMailboxes = action({
    args: {},
    returns: v.object({
        mailboxes: v.array(
            v.object({
                id: v.string(),
                displayName: v.string(),
                mail: v.string(),
            })
        ),
        defaultMailbox: v.union(v.string(), v.null()),
    }),
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
            return { mailboxes: [], defaultMailbox: null };
        }

        // We need to fetch the user role from db, but this is an action, not a query.
        // So we call an internal query to get user details
        const user = await ctx.runQuery(internal.users.getCurrentUserInternal, { clerkId: identity.subject });

        if (!user || user.status !== "active") {
            return { mailboxes: [], defaultMailbox: null };
        }

        const isAdmin = user.role === "admin";
        const userEmail = user.email.toLowerCase();

        // Get configured shared mailboxes from environment
        const configuredMailboxesStr = process.env.SHARED_MAILBOX_ADDRESSES || process.env.SHARED_MAILBOX_ADDRESS || "";

        if (!configuredMailboxesStr) {
            return {
                mailboxes: [],
                defaultMailbox: null,
            };
        }

        const allMailboxes: MailboxInfo[] = configuredMailboxesStr.split(",").map((entry) => {
            const trimmed = entry.trim();
            if (trimmed.includes(":")) {
                const [displayName, mail] = trimmed.split(":");
                return {
                    id: mail.trim(),
                    displayName: displayName.trim(),
                    mail: mail.trim(),
                };
            }
            // If no display name provided, extract from email
            const displayName = trimmed.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            return {
                id: trimmed,
                displayName,
                mail: trimmed,
            };
        });

        // Ensure user's own email is always in the list if they are allowed to send from it
        // We can optionally add it if it's not in the env vars, but graph API needs permissions for it.
        // Assuming the app has Tenant-wide send permissions, we can just allow the user to send as themselves.
        const userMailbox: MailboxInfo = {
            id: userEmail,
            displayName: user.name || userEmail.split("@")[0],
            mail: userEmail
        };

        const hasUserMailbox = allMailboxes.some(m => m.mail.toLowerCase() === userEmail);
        if (!hasUserMailbox) {
            allMailboxes.push(userMailbox);
        }

        // Filter mailboxes based on role
        let allowedMailboxes = allMailboxes;
        if (!isAdmin) {
            allowedMailboxes = allMailboxes.filter(m => m.mail.toLowerCase() === userEmail);
        }

        // If default from env is not in the allowed list, default is null to force selection or use first allowed
        const configuredDefault = process.env.SHARED_MAILBOX_ADDRESS || null;
        let defaultMailbox = configuredDefault;

        if (defaultMailbox && !allowedMailboxes.some((m) => m.mail.toLowerCase() === defaultMailbox?.toLowerCase())) {
            defaultMailbox = allowedMailboxes.length > 0 ? allowedMailboxes[0].mail : null;
        }

        return {
            mailboxes: allowedMailboxes,
            defaultMailbox,
        };
    },
});

/**
 * Verify that we can send from a specific mailbox
 * This helps validate mailbox access before sending
 */
export const verifyMailboxAccess = action({
    args: {
        mailboxAddress: v.string(),
    },
    returns: v.object({
        hasAccess: v.boolean(),
        error: v.optional(v.string()),
    }),
    handler: async (ctx, args) => {
        try {
            const token = await getGraphAccessToken();

            // Try to get the mailbox settings (read-only) to verify access
            const url = `https://graph.microsoft.com/v1.0/users/${args.mailboxAddress}/mailboxSettings`;

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (response.ok) {
                return { hasAccess: true };
            }

            if (response.status === 403 || response.status === 401) {
                return {
                    hasAccess: false,
                    error: "No permission to send from this mailbox",
                };
            }

            return {
                hasAccess: false,
                error: `Unable to verify mailbox: ${response.status}`,
            };
        } catch (err) {
            return {
                hasAccess: false,
                error: err instanceof Error ? err.message : "Unknown error",
            };
        }
    },
});
