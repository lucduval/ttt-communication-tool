export async function rewriteEmailLinks(
    htmlBody: string,
    siteUrl: string,
    campaignId: string,
    recipientId: string
): Promise<string> {
    if (!siteUrl) {
        return htmlBody;
    }

    // We cannot use replace(regex, async callback) directly.
    // So we assume we'll find matches and rebuild or replace them one by one.
    // A simple regex approach with matchAll is safer.

    const regex = /href=["']([^"']*)["']/g;
    const matches = Array.from(htmlBody.matchAll(regex));

    // We'll process matches in reverse order to preserve indices for replacement?
    // Or just build a replacements map and replace.
    // Actually, `replace` with strings replaces only the first occurrence or we can build a new string.
    // Since we are replacing distinct links, let's use a "replaceAsync" pattern helper.

    // Simpler efficient way: split the string by matches? No.
    // Let's use the standard "replace async" pattern.

    let result = htmlBody;
    // Process replacements
    // Note: matchAll returns an iterator. We convert to array to await all signatures.
    // But modifying the string while iterating is tricky with indices.
    // Easier strategy: Find all, compute signatures, then doing a sync replace or rebuilding.

    const replacements = await Promise.all(matches.map(async (match) => {
        const fullMatch = match[0]; // href="..."
        const url = match[1];       // http://...

        // Skip logic
        if (url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("#")) {
            return { fullMatch, replacement: fullMatch };
        }
        if (!url.startsWith("http")) {
            return { fullMatch, replacement: fullMatch };
        }

        const rawTrackingUrl = `${siteUrl}/click?u=${encodeURIComponent(url)}&c=${campaignId}&r=${recipientId}`;
        const trackingUrl = await signUrl(rawTrackingUrl);
        // We carefully reconstruct the href attribute with the quote style used
        const quote = fullMatch.startsWith('href="') ? '"' : "'";
        return { fullMatch, replacement: `href=${quote}${trackingUrl}${quote}` };
    }));

    // Now apply replacements.
    // CAUTION: Naive string replace might replace wrong instances if duplicate links exist.
    // However, if we replace globally for each unique mapping, we might be fine?
    // Or we iterate and rebuild the string.

    // Robust Rebuild Strategy:
    // 1. Identify all match indices and lengths.
    // 2. Sort by index.
    // 3. Slice and append.

    let lastIndex = 0;
    let builtBody = "";

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const replacement = replacements[i].replacement;

        // Append text before this match
        builtBody += htmlBody.substring(lastIndex, match.index);
        // Append replacement
        builtBody += replacement;
        // Update last index
        lastIndex = (match.index || 0) + match[0].length;
    }
    // Append remaining text
    builtBody += htmlBody.substring(lastIndex);

    // Add open tracking pixel
    const openTrackingUrl = `${siteUrl}/open?c=${campaignId}&r=${recipientId}`;
    const trackingPixel = `<img src="${openTrackingUrl}" width="1" height="1" alt="" style="display:none;" />`;

    // Insert pixel before </body> if it exists, otherwise append
    if (builtBody.includes("</body>")) {
        builtBody = builtBody.replace("</body>", `${trackingPixel}</body>`);
    } else {
        builtBody += trackingPixel;
    }

    return builtBody;
}

// Secret for signing URLs - strict fallback to complex string if env var missing
const TRACKING_SECRET = process.env.TRACKING_SECRET || "fallback_secret_change_me_in_prod_12345";

async function generateSignature(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TRACKING_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(data)
    );

    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export async function signUrl(url: string): Promise<string> {
    // We sign the query string part
    const urlObj = new URL(url);
    const signature = await generateSignature(urlObj.search);
    urlObj.searchParams.append("s", signature);
    return urlObj.toString();
}

export async function verifyUrlSignature(url: string): Promise<boolean> {
    const urlObj = new URL(url);
    const signature = urlObj.searchParams.get("s");
    if (!signature) return false;

    // Remove signature to verify the rest
    urlObj.searchParams.delete("s");
    const expectedSignature = await generateSignature(urlObj.search);

    return signature === expectedSignature;
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
