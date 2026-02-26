import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const fetchRawMessage = internalAction({
    args: { mailbox: v.string() },
    handler: async (ctx, args) => {
        const tokenResponse = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: process.env.GRAPH_CLIENT_ID!,
                scope: "https://graph.microsoft.com/.default",
                client_secret: process.env.GRAPH_CLIENT_SECRET!,
                grant_type: "client_credentials",
            }),
        });

        const tokenData = await tokenResponse.json();
        const token = tokenData.access_token;

        // Get the latest sent item to see how Graph built the message
        const messagesResp = await fetch(`https://graph.microsoft.com/v1.0/users/${args.mailbox}/messages?$top=1&$orderby=sentDateTime desc`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const messagesData = await messagesResp.json();
        
        if (!messagesData.value || messagesData.value.length === 0) {
            return { success: false, error: "No messages found" };
        }
        
        const messageId = messagesData.value[0].id;
        
        // Fetch MIME content
        const mimeResp = await fetch(`https://graph.microsoft.com/v1.0/users/${args.mailbox}/messages/${messageId}/$value`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const text = await mimeResp.text();
        return { success: true, preview: text };
    }
});
