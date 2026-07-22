import { internalMutation } from "./_generated/server";

/**
 * One-shot seed of the bad-debt recovery email templates extracted from
 * `bad-debt-templates.html` (PRD prd-bad-debt-excel-campaign). Six campaigns —
 * three age bands, each in a relationship-led ("Paid before") and a professional
 * ("Never paid") variant — with four spaced touches apiece (Day 0 / 10 / 25 / 40).
 *
 * Merge fields use the app's single-curly-brace syntax (`{key}`) so they resolve
 * through convex/lib/applyMerge.ts at send time; unresolved fields render empty.
 * The keys mirror the human-readable labels from the source doc — for an
 * uploaded-file campaign these bind on the matching Excel column header.
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
        subject: "Invoice {invoice_number}: the simplest way to settle",
        paragraphs: [
            "Hi {first_name},",
            "It has been good working with you since {client_since}. Invoice {invoice_number} for {amount_formatted}, issued {invoice_issue_date}, is now due.",
            "You can settle it securely in one step using the button below.",
            "If a single payment is tricky, just reply and we will set up a short plan that suits you.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 10 (follow-up)",
        subject: "A quick follow-up on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Just following up: invoice {invoice_number} ({amount_formatted}) is still open. Whenever it suits you, you can settle it in one step using the button below.",
            "Prefer to spread it? Reply and we will arrange a short plan.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 25 (firm reminder)",
        subject: "Invoice {invoice_number} still needs settling",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} ({amount_formatted}) has now been open a few weeks and we would like to get it resolved with you. Please settle it below when you can.",
            "If anything about the invoice is unclear, or a payment plan would help, reply and we will sort it out.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Paid before · Day 40 (final notice)",
        subject: "Final reminder on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "This is a final reminder on invoice {invoice_number} ({amount_formatted}). We would much rather settle it with you directly than take it any further. Please pay below, or reply so we can find a way forward together.",
            SIGN_KIND,
        ],
    },

    // ── 30–90 days · Never paid (professional) ───────────────────────────────
    {
        name: "Bad debt · 30–90 days · Never paid · Day 0 (opening)",
        subject: "Invoice {invoice_number}: your balance and how to settle",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} for {amount_formatted}, issued {invoice_issue_date}, is currently unpaid. Here is a clear, simple way to settle it — use the button below.",
            "If you believe the balance is not correct, or you would like to arrange a payment plan, reply and we will look into it with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 10 (follow-up)",
        subject: "Following up on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Following up on invoice {invoice_number} ({amount_formatted}), which is still open. You can settle it in one step using the button below.",
            "If you cannot pay in full, or believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 25 (firm reminder)",
        subject: "Action needed on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} ({amount_formatted}) remains unpaid and now needs your attention. Please settle it using the button below.",
            "If there is a dispute, or you need a payment plan, reply and we will work it through with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 30–90 days · Never paid · Day 40 (final notice)",
        subject: "Final notice: invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "This is a final notice on invoice {invoice_number} ({amount_formatted}). If it stays unpaid and we do not hear from you, the account will be referred to our recoveries process. We would much prefer to resolve it with you first, so please settle using the button below, or reply.",
            SIGN_REGARDS,
        ],
    },

    // ── 90 days–1 year · Paid before (tax-season hook) ───────────────────────
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 0 (opening)",
        subject: "Tax season is open, let's clear invoice {invoice_number} and start your return",
        paragraphs: [
            "Hi {first_name},",
            "Tax season has just opened and we would love to handle your return again this year. We cannot start while an invoice is open, so clearing invoice {invoice_number} ({amount_formatted}, issued {invoice_issue_date}) now means we can get straight onto your filing.",
            "Settle securely in one step using the button below.",
            "If paying in one go is tricky, reply and we will set up a short plan.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 10 (follow-up)",
        subject: "Your tax return is ready to start, invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Filing season is underway and your return is ready to start. We just need invoice {invoice_number} ({amount_formatted}) settled first — use the button below.",
            "Prefer to spread it? Reply and we will arrange a short plan.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 25 (firm reminder)",
        subject: "Season is moving, invoice {invoice_number} is holding up your return",
        paragraphs: [
            "Hi {first_name},",
            "Season deadlines do not wait, and invoice {invoice_number} ({amount_formatted}) is still open, which is holding up your return. Let us clear it and get your filing moving using the button below.",
            "If a payment plan would help, reply and we will set one up.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Paid before · Day 40 (final notice)",
        subject: "Final reminder: clear invoice {invoice_number} so we can file in time",
        paragraphs: [
            "Hi {first_name},",
            "Final reminder on invoice {invoice_number} ({amount_formatted}). With season already open, we would hate for the delay to cost you your filing window. Clear it using the button below and we will prioritise your return, or reply and we will help.",
            SIGN_KIND,
        ],
    },

    // ── 90 days–1 year · Never paid (tax-season hook) ────────────────────────
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 0 (opening)",
        subject: "Tax season is open, settling invoice {invoice_number} lets us start your return",
        paragraphs: [
            "Hi {first_name},",
            "Tax season has just opened and we would be glad to file your return this year. We cannot begin while an invoice is unpaid, so settling invoice {invoice_number} ({amount_formatted}, issued {invoice_issue_date}) clears the way to start.",
            "Settle securely in one step using the button below.",
            "If you cannot pay in full, or believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 10 (follow-up)",
        subject: "Your tax return is ready to start, invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Filing season is underway and your return is ready to start. We just need invoice {invoice_number} ({amount_formatted}) settled first — use the button below.",
            "If you cannot pay in full, or believe the balance is wrong, reply and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 25 (firm reminder)",
        subject: "Season is moving, invoice {invoice_number} is still open",
        paragraphs: [
            "Hi {first_name},",
            "Season deadlines do not wait, and invoice {invoice_number} ({amount_formatted}) is still unpaid, which is holding up your return. Please settle it using the button below.",
            "If there is a dispute, or you need a payment plan, reply and we will work it through.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 90 days–1 year · Never paid · Day 40 (final notice)",
        subject: "Final notice: invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Final notice on invoice {invoice_number} ({amount_formatted}). Settle now and we can still fit your return in this season; if it stays unpaid and we do not hear from you, the account will be referred to our recoveries process.",
            "Settle securely in one step using the button below.",
            SIGN_REGARDS,
        ],
    },

    // ── 1–3 years · Paid before (near prescription, concession-led) ──────────
    {
        name: "Bad debt · 1–3 years · Paid before · Day 0 (opening)",
        subject: "Let's find a way to close invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "It has been a while, and we would like to help you close off invoice {invoice_number} ({amount_formatted}, issued {invoice_issue_date}) rather than let it drift any longer.",
            "If you can settle it in one step, the button below is the quickest way. And if a single payment is not realistic, just reply, and we will set up a comfortable payment plan. That is genuinely the easiest way to put this behind you.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 10 (follow-up)",
        subject: "A payment plan is on the table for invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Following up on invoice {invoice_number} ({amount_formatted}). There is no need to pay it all at once, a short payment plan is completely fine. Reply and we will arrange one, or settle in full using the button below.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 25 (firm reminder)",
        subject: "Invoice {invoice_number}: let's get it resolved",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} ({amount_formatted}) is still open and we would really like to resolve it with you. Whatever suits you, settle in full using the button below, or reply and we will put a plan in place.",
            "If you believe the balance is not right, tell us and we will check it.",
            SIGN_KIND,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Paid before · Day 40 (final notice)",
        subject: "A last note on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "A final note on invoice {invoice_number} ({amount_formatted}). We would much rather settle it with you, on a plan if that helps, than take it any further. Reply to us or use the button below and we will help you close it.",
            SIGN_KIND,
        ],
    },

    // ── 1–3 years · Never paid (near prescription, plan-first) ───────────────
    {
        name: "Bad debt · 1–3 years · Never paid · Day 0 (opening)",
        subject: "Invoice {invoice_number}: options to settle or query",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} for {amount_formatted}, issued {invoice_issue_date}, has been outstanding for some time and we would like to help you resolve it. You can settle it in one step using the button below.",
            "If a single payment is not realistic, reply and we will set up a payment plan. And if you believe the balance is not correct, tell us and we will look into it with you.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 10 (follow-up)",
        subject: "Following up on invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Following up on invoice {invoice_number} ({amount_formatted}). A payment plan is available if paying in full is not realistic, just reply. Otherwise you can settle using the button below.",
            "If you believe the balance is wrong, reply and we will check it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 25 (firm reminder)",
        subject: "Invoice {invoice_number} still needs resolving",
        paragraphs: [
            "Hi {first_name},",
            "Invoice {invoice_number} ({amount_formatted}) remains unpaid and we would like to get it resolved. Settle using the button below, reply for a payment plan, or tell us if you dispute the balance and we will look into it.",
            SIGN_REGARDS,
        ],
    },
    {
        name: "Bad debt · 1–3 years · Never paid · Day 40 (final notice)",
        subject: "Final notice: invoice {invoice_number}",
        paragraphs: [
            "Hi {first_name},",
            "Final notice on invoice {invoice_number} ({amount_formatted}). We would much prefer to resolve it with you, in full or on a plan, than refer it to our recoveries process. Please settle using the button below, or reply and we will help.",
            SIGN_REGARDS,
        ],
    },
];

export const seedBadDebtEmailTemplates = internalMutation({
    args: {},
    handler: async (ctx) => {
        // Templates need an owner (createdBy). Prefer an admin, else any user.
        // They are seeded "shared", so every user sees them regardless of owner.
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
                // merge fields on templates seeded earlier. Ownership and
                // visibility are left as-is.
                await ctx.db.patch(existing._id, {
                    subject: t.subject,
                    htmlContent,
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
                visibility: "shared",
            });
            created++;
        }

        return { created, updated, total: TEMPLATES.length };
    },
});
