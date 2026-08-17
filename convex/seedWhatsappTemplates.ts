import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Temporary inspection helper — lists the bad-debt WhatsApp templates currently
 * in the deployment with their Meta template id, category and visibility, so we
 * can confirm state before re-seeding. Safe/read-only. Run with
 * `npx convex run seedWhatsappTemplates:inspectBadDebt`.
 */
export const inspectBadDebt = internalQuery({
    args: {},
    handler: async (ctx) => {
        const all = await ctx.db.query("whatsappTemplates").collect();
        return all
            .filter((t) => t.name.startsWith("Bad debt · WhatsApp ·"))
            .map((t) => ({
                name: t.name,
                metaTemplateId: t.metaTemplateId,
                category: t.category,
                status: t.status,
                visibility: t.visibility ?? "(unset → shared)",
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    },
});

/**
 * One-shot seed of the bad-debt-recovery WhatsApp templates — the WhatsApp
 * counterparts of the email campaigns in `seedTemplates.ts`, extracted from the
 * WhatsApp column of `bad-debt-templates.html` (PRD prd-bad-debt-excel-campaign).
 * Six campaigns — three age bands, each in a relationship-led ("Paid before") and
 * a professional ("Never paid") variant — with four spaced touches apiece
 * (Day 0 / 10 / 25 / 40), i.e. 24 templates that line up 1:1 with the email set.
 *
 * These records mirror templates that MUST be created and approved in Meta
 * Business Suite first — the app can only *send* an approved template, and Meta
 * matches on `metaTemplateId` + `language`. Seed AFTER approval (or flip STATUS
 * to "pending" until then). When you submit each to Meta, configure it as:
 *
 *   • Category  : Utility
 *   • Header    : Document — the per-recipient invoice PDF is uploaded and
 *                 attached at send time (#68/#70); no header sample URL is stored.
 *   • Body      : the `body` text below, verbatim, with {{1}} {{2}}.
 *   • Footer    : "TTT Financial Group"  ← set this in Meta. A WhatsApp footer is
 *                 NOT a runtime component — it is baked into the approved template
 *                 and Meta renders it automatically, so there is no field for it
 *                 here and the send path never transmits it.
 *   • Button    : URL, label "Pay now", url `${PAY_URL_PREFIX}{{1}}`. Meta stores
 *                 the fixed prefix; at send time we supply only the per-recipient
 *                 SUFFIX (the payment token) that replaces {{1}} — Meta rebuilds
 *                 prefix + suffix.
 *
 * The consultant name is deliberately absent from every message: these send from
 * TTT's business number, and the footer carries the TTT identity.
 *
 * Variables are POSITIONAL ({{1}} {{2}}), the universally Meta-approvable
 * form that `isPositional()` in `lib/whatsapp.ts` handles. Logical binding:
 *   {{1}} → first name        (column mapped per-campaign; default "first_name")
 *   {{2}} → amount, formatted  (default "amount_formatted", already incl. "R")
 *   button {{1}} → payment token/suffix (variable "payment_link", default column
 *                  "payment_link"; the cell holds ONLY the suffix, not a full URL)
 * On the Excel-driven path the variable→column mapping lives on the *campaign*
 * (`whatsappVariableMappings`), not the template; `variableMappings` below is the
 * default/Dynamics fallback and documents the intended columns.
 *
 * Idempotent: templates already present (matched by name) are upserted — body,
 * header, button and mappings are refreshed so re-running realigns them; owner
 * and visibility are left as-is. Run with
 * `npx convex run seedWhatsappTemplates:seedBadDebtWhatsappTemplates`.
 */

// Fixed prefix of the approved Meta "Pay now" URL button. At send time we pass
// only the per-recipient suffix that replaces {{1}}; Meta concatenates the two.
export const PAY_URL_PREFIX = "https://payment-link-ttt.azurewebsites.net/p/";
export const PAY_URL = `${PAY_URL_PREFIX}{{1}}`;

// These mirror templates approved in Meta; run the seed once approval lands. The
// status is display-only in this app (it never gates selection or sending).
const STATUS = "approved";

// Default logical variable → column bindings (the campaign mapping overrides on
// the Excel path). Serialised onto each template as `variableMappings`.
const DEFAULT_MAPPINGS = JSON.stringify({
    "1": "first_name",
    "2": "amount_formatted",
    payment_link: "payment_link",
});

export interface SeedWaTemplate {
    name: string;
    metaTemplateId: string;
    /** Situational opener, following "Hi {{1}}, ". */
    intro: string;
    /** The closing call-to-action line (references the "Pay now" button). */
    closer: string;
}

// Every body shares the same skeleton so the two positional variables and the
// amount line stay identical across all 24 templates. Blank lines separate the
// three blocks so the message reads with generous, breathing spacing (WhatsApp
// renders a blank line for each \n\n):
//   Hi {{1}}, <intro>
//
//   Amount due: {{2}}
//
//   <closer>
export function buildBody(t: SeedWaTemplate): string {
    return `Hi {{1}}, ${t.intro}\n\nAmount due: {{2}}\n\n${t.closer}`;
}

export const TEMPLATES: SeedWaTemplate[] = [
    // ── 30–90 days · Paid before (relationship-led) ──────────────────────────
    {
        name: "Bad debt · WhatsApp · 30–90 days · Paid before · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_30_90_paid_before_day0",
        intro: "it's been great having you as a client. Quick one on an open invoice:",
        closer: "Tap *Pay now* below to settle in one step, or reply here if you have any questions.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Paid before · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_30_90_paid_before_day10",
        intro: "just following up on an open invoice:",
        closer: "You can pay in one tap — use *Pay now* below.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Paid before · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_30_90_paid_before_day25",
        intro: "this one has been open a few weeks now:",
        closer: "Please settle it using *Pay now* below, or reply if you have any questions.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Paid before · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_30_90_paid_before_day40",
        intro: "a final reminder on an open invoice:",
        closer: "We would much rather sort this out with you before it goes further. Use *Pay now* below, or reply and we will help.",
    },

    // ── 30–90 days · Never paid (professional) ───────────────────────────────
    {
        name: "Bad debt · WhatsApp · 30–90 days · Never paid · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_30_90_never_paid_day0",
        intro: "thank you for choosing TTT. To settle your account:",
        closer: "Settle securely using *Pay now* below. Reply if the balance looks wrong.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Never paid · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_30_90_never_paid_day10",
        intro: "following up on an open invoice:",
        closer: "Use *Pay now* below, or reply if you need to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Never paid · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_30_90_never_paid_day25",
        intro: "this still needs settling:",
        closer: "Please pay using *Pay now* below, or reply to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 30–90 days · Never paid · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_30_90_never_paid_day40",
        intro: "a final notice on your account:",
        closer: "Please settle using *Pay now* below to avoid it being referred further.",
    },

    // ── 90 days–1 year · Paid before (tax-season hook) ───────────────────────
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Paid before · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_90d_1y_paid_before_day0",
        intro: "tax season is open and we would love to do your return, but we cannot start while your account is open:",
        closer: "Clear it using *Pay now* below and we will get straight onto your filing.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Paid before · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_90d_1y_paid_before_day10",
        intro: "your return is ready to start — we just need this settled first:",
        closer: "Use *Pay now* below.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Paid before · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_90d_1y_paid_before_day25",
        intro: "this is still holding up your return and season deadlines do not wait:",
        closer: "Settle it using *Pay now* below.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Paid before · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_90d_1y_paid_before_day40",
        intro: "a final reminder — clearing this now protects your filing window this season:",
        closer: "Use *Pay now* below, or reply and we will help.",
    },

    // ── 90 days–1 year · Never paid (tax-season hook) ────────────────────────
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Never paid · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_90d_1y_never_paid_day0",
        intro: "tax season is open and settling your account clears the way to start your return:",
        closer: "Use *Pay now* below. Reply if the balance looks wrong.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Never paid · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_90d_1y_never_paid_day10",
        intro: "your return is ready to start — we just need this settled first:",
        closer: "Use *Pay now* below, or reply to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Never paid · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_90d_1y_never_paid_day25",
        intro: "this is still open and holding up your return:",
        closer: "Settle using *Pay now* below, or reply to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 90 days–1 year · Never paid · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_90d_1y_never_paid_day40",
        intro: "a final notice — settle now and we can still fit your return in this season:",
        closer: "Use *Pay now* below.",
    },

    // ── 1–3 years · Paid before (near prescription, concession-led) ──────────
    {
        name: "Bad debt · WhatsApp · 1–3 years · Paid before · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_1_3y_paid_before_day0",
        intro: "we would like to help you close this off:",
        closer: "Pay in one step using *Pay now* below, or reply if you have any questions.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Paid before · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_1_3y_paid_before_day10",
        intro: "just following up on this:",
        closer: "You can settle it in one tap — use *Pay now* below.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Paid before · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_1_3y_paid_before_day25",
        intro: "we would like to get this resolved with you:",
        closer: "Use *Pay now* below, or reply if you have any questions.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Paid before · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_1_3y_paid_before_day40",
        intro: "a last note — we would much rather settle this with you:",
        closer: "Reply, or use *Pay now* below.",
    },

    // ── 1–3 years · Never paid (near prescription, resolution-led) ───────────
    {
        name: "Bad debt · WhatsApp · 1–3 years · Never paid · Day 0 (opening)",
        metaTemplateId: "bad_debt_wa_1_3y_never_paid_day0",
        intro: "this has been outstanding a while and we would like to help resolve it:",
        closer: "Settle using *Pay now* below, or reply to query the balance.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Never paid · Day 10 (follow-up)",
        metaTemplateId: "bad_debt_wa_1_3y_never_paid_day10",
        intro: "just following up on this:",
        closer: "Settle using *Pay now* below, or reply to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Never paid · Day 25 (firm reminder)",
        metaTemplateId: "bad_debt_wa_1_3y_never_paid_day25",
        intro: "this still needs resolving:",
        closer: "Use *Pay now* below, or reply to query it.",
    },
    {
        name: "Bad debt · WhatsApp · 1–3 years · Never paid · Day 40 (final notice)",
        metaTemplateId: "bad_debt_wa_1_3y_never_paid_day40",
        intro: "a final notice — we would rather resolve this with you directly:",
        closer: "Use *Pay now* below, or reply.",
    },
];

export const seedBadDebtWhatsappTemplates = internalMutation({
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

        // Shared across all 24 — positional body vars, document (invoice PDF)
        // header, and the "Pay now" dynamic URL button.
        const shared = {
            category: "utility",
            status: STATUS,
            variables: ["1", "2"],
            variableMappings: DEFAULT_MAPPINGS,
            language: "en",
            headerType: "document",
            buttonType: "url",
            buttonText: "Pay now",
            buttonUrl: PAY_URL,
            buttonUrlVariable: "payment_link",
            button2Type: "none",
            visibility: "shared" as const,
        };

        let created = 0;
        let updated = 0;
        for (const t of TEMPLATES) {
            const body = buildBody(t);
            const existing = await ctx.db
                .query("whatsappTemplates")
                .withIndex("by_meta_id", (q) => q.eq("metaTemplateId", t.metaTemplateId))
                .first();
            if (existing) {
                // Upsert — refresh body/header/button/mappings so re-running
                // realigns templates seeded earlier. Ownership and visibility
                // are left as-is. Invalidate any cached header media id since the
                // header source is per-recipient (not a fixed url) anyway.
                await ctx.db.patch(existing._id, {
                    name: t.name,
                    body,
                    ...shared,
                    visibility: existing.visibility ?? shared.visibility,
                    headerMediaId: undefined,
                    headerMediaIdUploadedAt: undefined,
                    headerMediaSourceUrl: undefined,
                    headerMediaMimeType: undefined,
                    lastUpdatedAt: Date.now(),
                });
                updated++;
                continue;
            }
            await ctx.db.insert("whatsappTemplates", {
                name: t.name,
                metaTemplateId: t.metaTemplateId,
                body,
                ...shared,
                createdBy: owner._id,
                lastUpdatedAt: Date.now(),
            });
            created++;
        }

        return { created, updated, total: TEMPLATES.length };
    },
});
