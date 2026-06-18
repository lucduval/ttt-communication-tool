"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";
import { dynamicsRequest } from "../lib/dynamics_auth";
import { calculateOptions, parseAgeFromIdNumber } from "../lib/taxCalculator";
import { generatePersonalisedCopy, type TaxScenarioContext } from "../lib/claude";
import { buildPersonalisedEmail } from "../lib/emailTemplatePersonalised";
import { fetchTaxProfile } from "../lib/taxProfile";

const DEFAULT_SYSTEM_PROMPT =
    "You are a friendly and professional tax advisor at TTT Group. Write warm but concise emails that are easy to understand. Avoid jargon. Do NOT invent or change any numbers — use the exact figures provided.";

async function fetchContactInfo(contactId: string): Promise<{ name: string; idNumber: string | null; dynamicsAge: number | null }> {
    const res = await dynamicsRequest<{ fullname: string; firstname: string | null; ttt_idnumber: string | null; riivo_age: number | null }>(
        `contacts(${contactId})?$select=fullname,firstname,ttt_idnumber,riivo_age`
    );
    return {
        name: res.firstname || res.fullname || "Client",
        idNumber: res.ttt_idnumber ?? null,
        dynamicsAge: res.riivo_age ?? null,
    };
}

/**
 * Generate a preview email for a single contact (called from frontend during preview step).
 */
export const generatePreviewEmail = action({
    args: {
        contactId: v.string(),
        aiPrompt: v.string(),
        aiSystemPrompt: v.string(),
        subject: v.string(),
        siteUrl: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        const [taxProfile, contactInfo] = await Promise.all([
            fetchTaxProfile(args.contactId),
            fetchContactInfo(args.contactId),
        ]);

        if (!taxProfile.ita34) {
            throw new Error(`No ITA34 data found for contact ${args.contactId}`);
        }

        const age = (contactInfo.idNumber ? parseAgeFromIdNumber(contactInfo.idNumber) : null) ?? contactInfo.dynamicsAge;
        const scenarios = calculateOptions(taxProfile, age);
        const recipientName = contactInfo.name;
        const targetYear = new Date().getFullYear() + 1;
        const convexSiteUrl = process.env.CONVEX_SITE_URL || args.siteUrl || "";
        const logoUrl = convexSiteUrl ? `${convexSiteUrl}/logo` : undefined;

        const scenarioContext: TaxScenarioContext = {
            recipientName,
            yearOfAssessment: scenarios.yearOfAssessment,
            targetYear,
            currentIncome: scenarios.currentSituation.income,
            currentTaxableIncome: scenarios.currentSituation.taxableIncome,
            currentRaContribution: scenarios.currentSituation.currentRa,
            maxAllowableRa: scenarios.currentSituation.maxAllowableRa,
            currentTaxLiability: scenarios.currentSituation.taxLiability,
            optionA: {
                additionalRa: scenarios.optionA.additionalRaContribution,
                monthlyRa: scenarios.optionA.monthlyAdditionalRa,
                taxSaving: scenarios.optionA.taxSaving,
                newTaxLiability: scenarios.optionA.taxAfter,
            },
            optionB: {
                additionalRa: scenarios.optionB.additionalRaContribution,
                monthlyRa: scenarios.optionB.monthlyAdditionalRa,
                taxSaving: scenarios.optionB.taxSaving,
                newTaxLiability: scenarios.optionB.taxAfter,
            },
            optionC: {
                additionalRa: scenarios.optionC.additionalRaContribution,
                monthlyRa: scenarios.optionC.monthlyAdditionalRa,
                taxSaving: scenarios.optionC.taxSaving,
                newTaxLiability: scenarios.optionC.taxAfter,
            },
            retirementProjection: scenarios.retirementProjection ?? undefined,
        };

        const copy = await generatePersonalisedCopy({
            systemPrompt: args.aiSystemPrompt || DEFAULT_SYSTEM_PROMPT,
            userPrompt: args.aiPrompt,
            scenarios: scenarioContext,
        });

        const html = buildPersonalisedEmail({
            copy,
            scenarios,
            recipientName,
            yearOfAssessment: scenarios.yearOfAssessment,
            targetYear,
            logoUrl,
        });

        return {
            html,
            income: scenarios.currentSituation.taxableIncome,
            raContribution: scenarios.currentSituation.currentRa,
            taxSaving: scenarios.optionC.taxSaving,
            yearOfAssessment: scenarios.yearOfAssessment,
        };
    },
});
