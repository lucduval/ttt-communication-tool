/**
 * `composeEmailContent` (pure core) tests — PRD #74 / issue #75.
 *
 * These assert the *external* behaviour a recipient would see: whether the unsubscribe
 * footer is present, and the fixed `body → disclaimer → unsubscribe footer` order — not
 * internal structure. The unsubscribe gating is the compliance decision, so it is the
 * primary target.
 */
import { describe, it, expect } from "vitest";
import { composeEmailContent, getUnsubscribeFooter } from "../composeEmailContent";

const UNSUB = "https://app.example.com/unsubscribe?id=abc";

describe("composeEmailContent — unsubscribe gating", () => {
    it("Utility omits the unsubscribe footer even when an unsubscribe URL is supplied", () => {
        const html = composeEmailContent({
            body: "<p>Please settle the outstanding invoice.</p>",
            emailType: "utility",
            unsubscribeUrl: UNSUB,
        });
        expect(html).toBe("<p>Please settle the outstanding invoice.</p>");
        expect(html).not.toContain("unsubscribe here");
        expect(html).not.toContain(UNSUB);
    });

    it("Marketing appends the unsubscribe footer when a URL is present", () => {
        const html = composeEmailContent({
            body: "<p>Our latest offers.</p>",
            emailType: "marketing",
            unsubscribeUrl: UNSUB,
        });
        expect(html).toContain("<p>Our latest offers.</p>");
        expect(html).toContain("unsubscribe here");
        expect(html).toContain(UNSUB);
    });

    it("unset email type is treated as Marketing (footer present when a URL exists)", () => {
        const html = composeEmailContent({
            body: "<p>Legacy campaign.</p>",
            unsubscribeUrl: UNSUB,
        });
        expect(html).toContain("unsubscribe here");
        expect(html).toContain(UNSUB);
    });

    it("Marketing omits the footer when no unsubscribe URL is configured (today's behaviour)", () => {
        const html = composeEmailContent({
            body: "<p>No site URL configured.</p>",
            emailType: "marketing",
            unsubscribeUrl: "",
        });
        expect(html).toBe("<p>No site URL configured.</p>");
        expect(html).not.toContain("unsubscribe here");
    });
});

describe("composeEmailContent — append order", () => {
    it("appends body → disclaimer → unsubscribe footer in that order", () => {
        const html = composeEmailContent({
            body: "<p>BODY</p>",
            emailType: "marketing",
            unsubscribeUrl: UNSUB,
            disclaimerHtml: "<div>DISCLAIMER</div>",
        });
        const bodyIdx = html.indexOf("BODY");
        const disclaimerIdx = html.indexOf("DISCLAIMER");
        const footerIdx = html.indexOf("unsubscribe here");
        expect(bodyIdx).toBeGreaterThanOrEqual(0);
        expect(disclaimerIdx).toBeGreaterThan(bodyIdx);
        expect(footerIdx).toBeGreaterThan(disclaimerIdx);
    });

    it("places the disclaimer after the body and before the footer even for Utility (no footer)", () => {
        const html = composeEmailContent({
            body: "<p>BODY</p>",
            emailType: "utility",
            unsubscribeUrl: UNSUB,
            disclaimerHtml: "<div>DISCLAIMER</div>",
        });
        expect(html).toBe("<p>BODY</p><div>DISCLAIMER</div>");
    });

    it("appends nothing for an absent/empty disclaimer", () => {
        const html = composeEmailContent({
            body: "<p>BODY</p>",
            emailType: "marketing",
            unsubscribeUrl: "",
            disclaimerHtml: "",
        });
        expect(html).toBe("<p>BODY</p>");
    });
});

describe("getUnsubscribeFooter", () => {
    it("embeds the supplied unsubscribe URL", () => {
        expect(getUnsubscribeFooter(UNSUB)).toContain(UNSUB);
    });
});
