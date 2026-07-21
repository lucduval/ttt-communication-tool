import { internalMutation } from "./_generated/server";

/**
 * Seed of the default managed disclaimers (PRD #74). A "Standard" general
 * client-communication footer and a "Legal / collections" footer for bad-debt
 * sends, so the campaign picker is useful on day one.
 *
 * The HTML supports the same `{key}` merge fields as the body, resolved through
 * convex/lib/applyMerge.ts at send time; unresolved fields render empty.
 *
 * Idempotent, upsert-by-name (mirroring seedTemplates): a disclaimer already
 * present by name has its HTML refreshed, so re-running realigns wording.
 * Run with `npx convex run seedDisclaimers:seedDefaultDisclaimers`.
 */

interface SeedDisclaimer {
    name: string;
    isDefault?: boolean;
    htmlContent: string;
}

const DISCLAIMER_STYLE =
    "margin:24px 0 0 0;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;";

const DISCLAIMERS: SeedDisclaimer[] = [
    {
        name: "Standard",
        isDefault: true,
        htmlContent:
            `<p style="${DISCLAIMER_STYLE}">This email and any attachments are confidential and intended solely for the ` +
            `named recipient. If you have received this message in error, please notify us and delete it. ` +
            `TTT Financial Group accepts no liability for any loss or damage arising from its use.</p>`,
    },
    {
        name: "Legal / collections",
        htmlContent:
            `<p style="${DISCLAIMER_STYLE}">This is a communication regarding an outstanding account and should be treated ` +
            `as a formal request for payment. It does not constitute legal advice. If the balance has already been ` +
            `settled, please disregard this notice. TTT Financial Group reserves the right to pursue recovery of any ` +
            `amount that remains unpaid.</p>`,
    },
];

export const seedDefaultDisclaimers = internalMutation({
    args: {},
    handler: async (ctx) => {
        // Disclaimers need an owner (createdBy). Prefer an admin, else any user.
        const users = await ctx.db.query("users").collect();
        const owner = users.find((u) => u.role === "admin") ?? users[0];
        if (!owner) {
            throw new Error(
                "No users exist to own the seeded disclaimers — create a user first."
            );
        }

        let created = 0;
        let updated = 0;
        for (const d of DISCLAIMERS) {
            const existing = await ctx.db
                .query("disclaimers")
                .withIndex("by_name", (q) => q.eq("name", d.name))
                .first();
            if (existing) {
                // Upsert by name — refresh HTML so re-running realigns wording.
                // Ownership and archived state are left as-is.
                await ctx.db.patch(existing._id, {
                    htmlContent: d.htmlContent,
                    isDefault: d.isDefault,
                    lastUpdatedAt: Date.now(),
                });
                updated++;
                continue;
            }
            await ctx.db.insert("disclaimers", {
                name: d.name,
                htmlContent: d.htmlContent,
                isDefault: d.isDefault,
                createdBy: owner._id,
                lastUpdatedAt: Date.now(),
            });
            created++;
        }

        return { created, updated, total: DISCLAIMERS.length };
    },
});
