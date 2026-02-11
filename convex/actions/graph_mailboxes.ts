"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { getGraphAccessToken } from "../lib/graph_client";

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
    handler: async () => {
        // Get configured shared mailboxes from environment
        // Format: "name1:email1@domain.com,name2:email2@domain.com" or just "email1@domain.com,email2@domain.com"
        const configuredMailboxes = process.env.SHARED_MAILBOX_ADDRESSES || process.env.SHARED_MAILBOX_ADDRESS || "";
        const defaultMailbox = process.env.SHARED_MAILBOX_ADDRESS || null;

        if (!configuredMailboxes) {
            return {
                mailboxes: [],
                defaultMailbox: null,
            };
        }

        const mailboxes: MailboxInfo[] = configuredMailboxes.split(",").map((entry, index) => {
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

        return {
            mailboxes,
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
