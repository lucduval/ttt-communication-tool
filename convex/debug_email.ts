"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { sendEmail } from "./lib/graph_client";

export const testRawEmailSend = internalAction({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        const body = `
            <p>Testing inline image CID</p>
            <img src="cid:test_image_123" alt="Test Image" style="max-width:100%;" />
        `;

        // 1x1 transparent GIF base64
        const transparentGifBase64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

        // Hardcode a valid sending address for this test
        const validSender = process.env.SHARED_MAILBOX_ADDRESS?.split(",")[0] || "admin@ttt-tax.co.za";

        const result = await sendEmail({
            subject: "Test Raw Email Send",
            body: body,
            toRecipients: [{ email: args.email }],
            fromMailbox: validSender,
            attachments: [
                {
                    name: "test_image_123.gif",
                    contentType: "image/gif",
                    contentBase64: transparentGifBase64,
                    isInline: true
                }
            ]
        });

        return result;
    }
});
