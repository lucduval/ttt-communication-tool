
import { isBot } from "../tracking_utils";
import { describe, test, expect } from "vitest";

describe("isBot", () => {
    test("returns true for common bot user agents", () => {
        const botUAs = [
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
            "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
            "Twitterbot/1.0",
            "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Applebot/0.1; +http://www.apple.com/go/applebot)",
            "LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com/bot.html)",
            "TelegramBot (like TwitterBot)",
            "WhatsApp/2.21.12.21 A",
            "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 8_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12B410 Safari/600.1.4 (Applebot/0.1)"
        ];

        botUAs.forEach(ua => {
            expect(isBot(ua)).toBe(true);
        });
    });

    test("returns false for common browser user agents", () => {
        const humanUAs = [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
            "Mozilla/5.0 (iPad; CPU OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1"
        ];

        humanUAs.forEach(ua => {
            expect(isBot(ua)).toBe(false);
        });
    });

    test("returns false for empty or undefined user agent", () => {
        expect(isBot(undefined)).toBe(false);
        expect(isBot(null)).toBe(false);
        expect(isBot("")).toBe(false);
    });

    // Gmail image proxy is a special case we decided NOT to filter (for now)
    test("returns false for GoogleImageProxy", () => {
        const gmailUA = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
        expect(isBot(gmailUA)).toBe(false);
    });
});
