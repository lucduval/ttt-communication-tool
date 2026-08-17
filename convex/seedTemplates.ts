import { internalMutation } from "./_generated/server";

/**
 * One-shot seed of the bad-debt recovery email templates extracted from
 * `bad-debt-templates.html` (PRD prd-bad-debt-excel-campaign). Six campaigns —
 * three age bands, each in a relationship-led ("Paid before") and a professional
 * ("Never paid") variant — with four spaced touches apiece (Day 0 / 10 / 25 / 40).
 *
 * Wording is deliberately warm and spare: every touch merges only two fields —
 * `{first_name}` and `{amount_formatted}` — so no message ever looks cluttered
 * with brackets. Merge fields use the app's single-curly-brace syntax (`{key}`)
 * so they resolve through convex/lib/applyMerge.ts at send time; unresolved
 * fields render empty. The keys mirror the human-readable labels from the source
 * doc — for an uploaded-file campaign these bind on the matching Excel column
 * header.
 *
 * Idempotent: templates already present (matched by name) are skipped, so this
 * is safe to re-run. Run with `npx convex run seedTemplates:seedBadDebtEmailTemplates`.
 */

// TTT-hosted brand banners, dropped in as external image URLs (public blob
// storage) so they render in the composer and in the sent email untouched —
// they are not inline base64, so the save-time normaliser leaves them alone.
const HEADER_URL = "https://tttassets.blob.core.windows.net/assets/header_1.png";
const FOOTER_URL = "https://tttassets.blob.core.windows.net/assets/Footer_1.png";

const HEADER_HTML =
    `<p style="margin:0 0 20px 0;"><img src="${HEADER_URL}" alt="TTT Financial Group" style="width:100%;max-width:600px;height:auto;display:block;" /></p>`;
const FOOTER_HTML =
    `<p style="margin:24px 0 0 0;"><img src="${FOOTER_URL}" alt="TTT Financial Group" style="width:100%;max-width:600px;height:auto;display:block;" /></p>`;

// Centred "Pay now" call-to-action — the exact "bulletproof" markup the composer
// emits (buildButtonHtml in src/components/email/EmailComposer.tsx): a VML
// roundrect for Outlook inside an [if mso] block, a styled <a> for every other
// client. Orange preset (#F5821F), rounded corners, 140px wide, centre-aligned.
// The {payment_link} merge field is a `{`-led URL, so it is left verbatim and
// resolved per recipient at send time.
const CTA_BUTTON_HTML = `<div style="text-align:center;margin:16px 0;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{payment_link}" style="height:44px;v-text-anchor:middle;width:140px;" arcsize="18%" strokecolor="#F5821F" fillcolor="#F5821F">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Pay now</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="{payment_link}" target="_blank" rel="noopener noreferrer" style="background-color:#F5821F;border:2px solid #F5821F;border-radius:8px;box-sizing:border-box;color:#ffffff;display:inline-block;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;height:44px;line-height:44px;text-align:center;text-decoration:none;width:140px;-webkit-text-size-adjust:none;">Pay now</a>
<!--<![endif]-->
</div>`;

/**
 * Build the composer HTML: brand header, the body paragraphs (each with a bottom
 * margin so touches breathe instead of stacking single-spaced), a centred
 * "Pay now" CTA, the sign-off, then the brand footer. The sign-off is always the
 * last paragraph, so the CTA slots in just before it. `\n` becomes `<br>`.
 */
function html(paragraphs: string[]): string {
    const para = (p: string) =>
        `<p style="margin:0 0 16px 0;">${p.replace(/\n/g, "<br>")}</p>`;
    const bodyParas = paragraphs.slice(0, -1).map(para).join("");
    const signOff = para(paragraphs[paragraphs.length - 1]);
    return HEADER_HTML + bodyParas + CTA_BUTTON_HTML + signOff + FOOTER_HTML;
}

// Signed from the firm, not the individual consultant.
const SIGN_KIND = "Kind regards,\nTTT Financial Group";
const SIGN_REGARDS = "Regards,\nTTT Financial Group";

interface SeedTemplate {
    name: string;
    subject: string;
    paragraphs: string[];
}

const TEMPLATES: SeedTemplate[] = [
    // ── 30–90 days · Paid before (relationship-led) ──────────────────────────
    {
        name: "Bad debt · 30–90 days · Paid before · Day 0 (opening)",
        subject: "The simplest way to settle your account",
        paragraphs: [
            "Hi {first_name},",
            "It has been great having you as a client, and we would like to keep everything running smoothly on your account.",
            "Our records show there is still an outstanding invoice on your account of {amount_formatted}.",
            "To keep everything running smoothly, please settle your invoice securely using the Pay now button below.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 10 (follow-up)",
        subject: "A quick follow-up on your account",
        paragraphs: [
            "Hi {first_name},",
            "We hope you are well. We are just following up on your account, where our records show an outstanding invoice of {amount_formatted} still open.",
            "Whenever it suits you, you can settle it securely using the Pay now button below.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 25 (firm reminder)",
        subject: "Your invoice still needs settling",
        paragraphs: [
            "Hi {first_name},",
            "We would still like to get your account wrapped up with you. Your outstanding invoice of {amount_formatted} has now been open a few weeks.",
            "Please settle it securely using the Pay now button below. If anything is unclear, or a payment plan would help, just reply and we will sort it out.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 40 (final notice)",
        subject: "Final reminder on your account",
        paragraphs: [
            "Hi {first_name},",
            "This is a final reminder on your outstanding invoice of {amount_formatted}.",
            "We would much rather settle it with you directly than take it any further. Please settle securely using the Pay now button below, or reply and we will find a way forward together.",
            SIGN_KIND,
        ],
    },

    // ── 30–90 days · Never paid (professional) ───────────────────────────────
    {
        name: "Bad debt · 30–90 days · Never paid · Day 0 (opening)",
        subject: "Your balance and how to settle it",
        paragraphs: [
            "Hi {first_name},",
            "Thank you for choosing TTT for your tax work. We would like to make settling your account as easy as possible.",
            "Our records show an outstanding invoice on your account of {amount_formatted}.",
            "You can settle it securely in one step using the Pay now button below. If you believe the balance is not correct, just reply and we will look into it with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 10 (follow-up)",
        subject: "Following up on your invoice",
        paragraphs: [
            "Hi {first_name},",
            "We are following up to help you get your account settled. Our records show an outstanding invoice of {amount_formatted} still open.",
            "You can settle it securely using the Pay now button below. If you believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 25 (firm reminder)",
        subject: "Action needed on your account",
        paragraphs: [
            "Hi {first_name},",
            "Your outstanding invoice of {amount_formatted} remains unpaid and now needs your attention.",
            "Please settle it securely using the Pay now button below. If there is a dispute, or you need a payment plan, reply and we will work it through with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 40 (final notice)",
        subject: "Final notice on your account",
        paragraphs: [
            "Hi {first_name},",
            "This is a final notice on your outstanding invoice of {amount_formatted}.",
            "If it stays unpaid and we do not hear from you, the account will be referred to our recoveries process. We would much prefer to resolve it with you first, so please settle securely using the Pay now button below, or reply.",
            SIGN_REGARDS,
        ],
    },

    // ── 90 days–1 year · Paid before (tax-season hook) ───────────────────────
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 0 (opening)",
        subject: "Tax season is open, let's clear your account and start your return",
        paragraphs: [
            "Hi {first_name},",
            "Thank you for trusting us with your returns. Tax season has just opened and we would love to handle this year's too.",
            "We cannot start while an invoice is open, and our records show an outstanding invoice on your account of {amount_formatted}.",
            "Clear it securely using the Pay now button below and we will get straight onto your filing.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 10 (follow-up)",
        subject: "Your tax return is ready to start",
        paragraphs: [
            "Hi {first_name},",
            "Filing season is underway and your return is ready to start. We just need your outstanding invoice of {amount_formatted} settled first.",
            "You can settle it securely using the Pay now button below and we will get straight onto your return.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 25 (firm reminder)",
        subject: "Season is moving, your invoice is holding up your return",
        paragraphs: [
            "Hi {first_name},",
            "Season deadlines do not wait, and your outstanding invoice of {amount_formatted} is still holding up your return.",
            "Let us clear it and get your filing moving — settle securely using the Pay now button below. If a payment plan would help, just reply and we will set one up.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 40 (final notice)",
        subject: "Final reminder: clear your account so we can file in time",
        paragraphs: [
            "Hi {first_name},",
            "This is a final reminder on your outstanding invoice of {amount_formatted}.",
            "With season already open, we would hate for the delay to cost you your filing window. Clear it securely using the Pay now button below and we will prioritise your return, or reply and we will help.",
            SIGN_KIND,
        ],
    },

    // ── 90 days–1 year · Never paid (tax-season hook) ────────────────────────
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 0 (opening)",
        subject: "Tax season is open, settling your account lets us start your return",
        paragraphs: [
            "Hi {first_name},",
            "Tax season has just opened and we would be glad to file your return this year.",
            "We cannot begin while an invoice is unpaid, and our records show an outstanding invoice on your account of {amount_formatted}.",
            "Settle it securely using the Pay now button below and we can start. If you believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 10 (follow-up)",
        subject: "Your tax return is ready to start",
        paragraphs: [
            "Hi {first_name},",
            "Filing season is underway and your return is ready to start. We just need your outstanding invoice of {amount_formatted} settled first.",
            "You can settle it securely using the Pay now button below. If you believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 25 (firm reminder)",
        subject: "Season is moving, your invoice is still open",
        paragraphs: [
            "Hi {first_name},",
            "Season deadlines do not wait, and your outstanding invoice of {amount_formatted} is still unpaid, which is holding up your return.",
            "Please settle it securely using the Pay now button below. If there is a dispute, or you need a payment plan, reply and we will work it through.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 40 (final notice)",
        subject: "Final notice on your account",
        paragraphs: [
            "Hi {first_name},",
            "This is a final notice on your outstanding invoice of {amount_formatted}.",
            "Settle now and we can still fit your return in this season. If it stays unpaid and we do not hear from you, the account will be referred to our recoveries process, so please settle securely using the Pay now button below.",
            SIGN_REGARDS,
        ],
    },

    // ── 1–3 years · Paid before (near prescription, concession-led) ──────────
    {
        name: "Bad debt · 1–3 years · Paid before · Day 0 (opening)",
        subject: "Let's find a way to close your account",
        paragraphs: [
            "Hi {first_name},",
            "It has been a while, and as a valued client we would really like to help you close off your account rather than let it drift any longer.",
            "Our records show an outstanding invoice of {amount_formatted}.",
            "The Pay now button below is the quickest way to settle it in one step and put this behind you.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 10 (follow-up)",
        subject: "Let's close off your account",
        paragraphs: [
            "Hi {first_name},",
            "We are following up, and we would still really like to help you close this off. Our records show an outstanding invoice of {amount_formatted} still open.",
            "Settling in one step using the Pay now button below is the easiest way to put it behind you.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 25 (firm reminder)",
        subject: "Let's get your invoice resolved",
        paragraphs: [
            "Hi {first_name},",
            "Your outstanding invoice of {amount_formatted} is still open and we would really like to resolve it with you.",
            "Whatever suits you, settle in full using the Pay now button below, or reply and we will put a plan in place. If you believe the balance is not right, just tell us and we will check it.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 40 (final notice)",
        subject: "A last note on your account",
        paragraphs: [
            "Hi {first_name},",
            "This is a last note on your outstanding invoice of {amount_formatted}.",
            "We would much rather settle it with you, on a plan if that helps, than take it any further. Reply to us, or use the Pay now button below, and we will help you close it.",
            SIGN_KIND,
        ],
    },

    // ── 1–3 years · Never paid (near prescription, plan-first) ───────────────
    {
        name: "Bad debt · 1–3 years · Never paid · Day 0 (opening)",
        subject: "Options to settle or query your invoice",
        paragraphs: [
            "Hi {first_name},",
            "Your account has been outstanding for some time and we would like to help you resolve it.",
            "Our records show an outstanding invoice on your account of {amount_formatted}.",
            "You can settle it in one step using the Pay now button below. If you believe the balance is not correct, tell us and we will look into it with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 10 (follow-up)",
        subject: "Following up on your invoice",
        paragraphs: [
            "Hi {first_name},",
            "We are following up to help you get your account resolved. Our records show an outstanding invoice of {amount_formatted} still open.",
            "You can settle it in one step using the Pay now button below. If you believe the balance is wrong, reply and we will check it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 25 (firm reminder)",
        subject: "Your invoice still needs resolving",
        paragraphs: [
            "Hi {first_name},",
            "Your outstanding invoice of {amount_formatted} still needs resolving and we would like to sort it out with you.",
            "Settle using the Pay now button below, reply for a payment plan, or tell us if you dispute the balance and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 40 (final notice)",
        subject: "Final notice on your account",
        paragraphs: [
            "Hi {first_name},",
            "This is a final notice on your outstanding invoice of {amount_formatted}.",
            "We would much prefer to resolve it with you, in full or on a plan, than refer it to our recoveries process. Please settle using the Pay now button below, or reply and we will help.",
            SIGN_REGARDS,
        ],
    },
];

export const seedBadDebtEmailTemplates = internalMutation({
    args: {},
    handler: async (ctx) => {
        // Templates need an owner (createdBy). Prefer an admin, else any user.
        // They are seeded "private" (owner-only visibility), so they are not
        // shared across the org.
        const users = await ctx.db.query("users").collect();
        const owner = users.find((u) => u.role === "admin") ?? users[0];
        if (!owner) {
            throw new Error(
                "No users exist to own the seeded templates — create a user first."
            );
        }

        let created = 0;
        let updated = 0;
        for (const t of TEMPLATES) {
            const existing = await ctx.db
                .query("emailTemplates")
                .withIndex("by_name", (q) => q.eq("name", t.name))
                .first();
            const htmlContent = html(t.paragraphs);
            if (existing) {
                // Upsert by name — refresh subject/body so re-running realigns
                // merge fields on templates seeded earlier, and force
                // visibility to "private" so re-seeding also un-shares them.
                // Ownership (createdBy) is left as-is.
                await ctx.db.patch(existing._id, {
                    subject: t.subject,
                    htmlContent,
                    visibility: "private",
                    lastUpdatedAt: Date.now(),
                });
                updated++;
                continue;
            }
            await ctx.db.insert("emailTemplates", {
                name: t.name,
                subject: t.subject,
                htmlContent,
                createdBy: owner._id,
                lastUpdatedAt: Date.now(),
                fontSize: "18px",
                visibility: "private",
            });
            created++;
        }

        return { created, updated, total: TEMPLATES.length };
    },
});
