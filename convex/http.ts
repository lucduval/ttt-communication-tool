import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { unsubscribeContact } from "./lib/dynamics_logging";
import { isBot } from "./lib/tracking_utils";




import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

/**
 * GET /click?u=<url>&c=<campaignId>&r=<recipientId>
 * Logs the click and redirects to the target URL.
 */
http.route({
    path: "/click",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
        const url = new URL(request.url);
        const targetUrl = url.searchParams.get("u");
        const campaignId = url.searchParams.get("c");
        const recipientId = url.searchParams.get("r");

        if (!targetUrl || !campaignId || !recipientId) {
            return new Response("Missing parameters", { status: 400 });
        }

        // Log the click asynchronously
        try {
            await ctx.runMutation(internal.tracking.logClick, {
                campaignId: campaignId as Id<"campaigns">,
                recipientId: recipientId,
                url: targetUrl,
                userAgent: request.headers.get("user-agent") || undefined,
            });
        } catch (error) {
            console.error("Failed to log click:", error);
        }

        // Redirect to the target URL
        return new Response(null, {
            status: 302,
            headers: { Location: targetUrl },
        });
    }),
});

/**
 * GET /open?c=<campaignId>&r=<recipientId>
 * Logs the open and returns a transparent 1x1 GIF.
 */
http.route({
    path: "/open",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
        const url = new URL(request.url);
        const campaignId = url.searchParams.get("c");
        const recipientId = url.searchParams.get("r");

        if (campaignId && recipientId) {
            const userAgent = request.headers.get("user-agent");

            // Ignore bots and scanners to prevent premature opens
            if (!isBot(userAgent)) {
                // Log the open asynchronously
                try {
                    await ctx.runMutation(internal.tracking.logOpen, {
                        campaignId: campaignId as Id<"campaigns">,
                        recipientId: recipientId,
                        userAgent: userAgent || undefined,
                    });
                } catch (error) {
                    console.error("Failed to log open:", error);
                }
            } else {
                console.log(`Ignored bot open from UA: ${userAgent}`);
            }
        }

        // Return a 1x1 transparent GIF
        // Return a 1x1 transparent GIF
        const base64Gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        const binaryString = atob(base64Gif);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const gif = bytes;

        return new Response(gif, {
            status: 200,
            headers: {
                "Content-Type": "image/gif",
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        });
    }),
});

/**
 * Helper to validate a contactId query param. Returns the contactId or an error Response.
 */
function validateContactId(request: Request): string | Response {
    const url = new URL(request.url);
    const contactId = url.searchParams.get("id");

    if (!contactId) {
        return new Response(
            getResultHtml(false, "Invalid unsubscribe link. No contact identifier found."),
            { status: 400, headers: { "Content-Type": "text/html" } }
        );
    }

    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!guidRegex.test(contactId)) {
        return new Response(
            getResultHtml(false, "Invalid unsubscribe link."),
            { status: 400, headers: { "Content-Type": "text/html" } }
        );
    }

    return contactId;
}

/**
 * GET /unsubscribe?id=<contactId>
 * Shows a confirmation page — does NOT unsubscribe yet.
 */
http.route({
    path: "/unsubscribe",
    method: "GET",
    handler: httpAction(async (_ctx, request) => {
        const result = validateContactId(request);
        if (result instanceof Response) return result;

        return new Response(getConfirmHtml(result), {
            status: 200,
            headers: { "Content-Type": "text/html" },
        });
    }),
});

/**
 * POST /unsubscribe?id=<contactId>
 * Actually processes the unsubscribe in Dynamics 365.
 */
http.route({
    path: "/unsubscribe",
    method: "POST",
    handler: httpAction(async (_ctx, request) => {
        const result = validateContactId(request);
        if (result instanceof Response) return result;

        try {
            const success = await unsubscribeContact(result);

            if (success) {
                return new Response(
                    getResultHtml(true, "You have been successfully unsubscribed from our email communications."),
                    { status: 200, headers: { "Content-Type": "text/html" } }
                );
            } else {
                return new Response(
                    getResultHtml(false, "We were unable to process your unsubscribe request. Please contact support."),
                    { status: 500, headers: { "Content-Type": "text/html" } }
                );
            }
        } catch (err) {
            console.error("Unsubscribe error:", err);
            return new Response(
                getResultHtml(false, "An error occurred. Please try again later or contact support."),
                { status: 500, headers: { "Content-Type": "text/html" } }
            );
        }
    }),
});

/* ------------------------------------------------------------------ */
/*  HTML helpers                                                       */
/* ------------------------------------------------------------------ */

const PAGE_STYLE = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
       display: flex; justify-content: center; align-items: center;
       min-height: 100vh; margin: 0; background: #f7fafc; }
.card { border-radius: 12px; padding: 40px; max-width: 480px;
        text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.icon { font-size: 48px; margin-bottom: 16px; }
h1 { color: #2d3748; margin: 0 0 12px; font-size: 24px; }
p  { color: #4a5568; line-height: 1.6; margin: 0 0 24px; }
button { background: #e53e3e; color: #fff; border: none; border-radius: 8px;
         padding: 12px 32px; font-size: 16px; cursor: pointer; }
button:hover { background: #c53030; }`;

/** Confirmation page shown on GET */
function getConfirmHtml(contactId: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Unsubscribe</title><style>${PAGE_STYLE}</style></head>
<body>
<div class="card" style="background:#fff;border:2px solid #e2e8f0;">
    <div class="icon">📧</div>
    <h1>Unsubscribe</h1>
    <p>Are you sure you want to unsubscribe from our email communications?</p>
    <form method="POST" action="/unsubscribe?id=${encodeURIComponent(contactId)}">
        <button type="submit">Confirm Unsubscribe</button>
    </form>
</div>
</body></html>`;
}

/** Result page shown after POST (or on validation errors) */
function getResultHtml(success: boolean, message: string): string {
    const icon = success ? "✅" : "❌";
    const title = success ? "Unsubscribed" : "Unsubscribe Error";
    const bgColor = success ? "#f0fff4" : "#fff5f5";
    const borderColor = success ? "#38a169" : "#e53e3e";

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title><style>${PAGE_STYLE}</style></head>
<body>
<div class="card" style="background:${bgColor};border:2px solid ${borderColor};">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
</div>
</body></html>`;
}

export default http;
