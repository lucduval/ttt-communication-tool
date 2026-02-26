"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { sendEmail } from "./lib/graph_client";

export const testCidMatching = internalAction({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        // Fetch a real 200x200 image to avoid tracking pixel filters
        const testImageResp = await fetch("https://picsum.photos/200/200");
        const arrayBuffer = await testImageResp.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString('base64');

        const sender = "admin@ttt-tax.co.za";

        const subject = "CID Matching Test 6 (Real Size Image)";
        const body = `
            <h2>Testing CID with a real 200x200 image</h2>
            <p>If Graph API modifies the CID, let's try just plain numbers like the real emails: cid:12345</p>
            <br/>
            <p>12345: <br/><img alt="BROKEN_12345" src="cid:12345" style="border:1px solid black;"/></p>
        `;

        const attachments = [
            { name: "test_image.jpg", contentType: "image/jpeg", contentBase64: base64Image, isInline: true, contentId: "12345" },
        ];

        return await sendEmail({
            subject,
            body,
            toRecipients: [{ email: args.email }],
            fromMailbox: sender,
            attachments: attachments.map(a => ({
                name: a.name,
                contentType: a.contentType,
                contentBase64: a.contentBase64,
                isInline: a.isInline,
                contentId: a.contentId,
            }))
        });
    }
});
