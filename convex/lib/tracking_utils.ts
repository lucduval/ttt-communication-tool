export function rewriteEmailLinks(
    htmlBody: string,
    siteUrl: string,
    campaignId: string,
    recipientId: string
): string {
    if (!siteUrl) {
        return htmlBody;
    }

    let rewrittenBody = htmlBody;

    // Rewrite links for click tracking
    rewrittenBody = rewrittenBody.replace(/href=["']([^"']*)["']/g, (match, url) => {
        // Skip mailto, tel, and anchors
        if (url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("#")) {
            return match;
        }

        // Check if URL is absolute or relative (we only track absolute)
        if (!url.startsWith("http")) {
            return match;
        }

        const trackingUrl = `${siteUrl}/click?u=${encodeURIComponent(url)}&c=${campaignId}&r=${recipientId}`;
        return `href="${trackingUrl}"`;
    });

    // Add open tracking pixel
    const openTrackingUrl = `${siteUrl}/open?c=${campaignId}&r=${recipientId}`;
    const trackingPixel = `<img src="${openTrackingUrl}" width="1" height="1" alt="" style="display:none;" />`;

    // Insert pixel before </body> if it exists, otherwise append
    if (rewrittenBody.includes("</body>")) {
        rewrittenBody = rewrittenBody.replace("</body>", `${trackingPixel}</body>`);
    } else {
        rewrittenBody += trackingPixel;
    }

    return rewrittenBody;
}

/**
 * Check if the User-Agent string belongs to a known bot, crawler, or automated scanner.
 */
export function isBot(userAgent?: string | null): boolean {
    if (!userAgent) return false;
    const lower = userAgent.toLowerCase();

    // Common bot keywords
    const botKeywords = [
        "bot",
        "spider",
        "crawl",
        "preview",
        "scanner",
        "monitor",
        "headless",
        "facebookexternalhit",
        // "googleimageproxy", // Intentionally commented out: Gmail uses this, we want to track Gmail opens
        "bingpreview",
        "whatsapp",
        "telegrambot",
        "slackbot",
        "discordbot",
        "skypeuripreview",
        "applebot",
        "twitterbot",
        "linkedinbot",
        "embedly",
        "quora link preview",
        "showyoubot",
        "outbrain",
        "pinterest",
        "developers.google.com/+/web/snippet",
        "google-structured-data-testing-tool",
        "feedfetcher-google",
        "yahoo! slurp",
        "duckduckbot",
        "baiduspider",
        "yandex",
        "sogou",
        "exabot",
        "facebot",
        "ia_archiver"
    ];

    return botKeywords.some(keyword => lower.includes(keyword));
}
