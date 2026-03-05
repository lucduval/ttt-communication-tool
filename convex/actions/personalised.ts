"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";
import { dynamicsRequest } from "../lib/dynamics_auth";
import { calculateOptions, parseAgeFromIdNumber } from "../lib/taxCalculator";
import { generatePersonalisedCopy, type TaxScenarioContext } from "../lib/gemini";
import { buildPersonalisedEmail } from "../lib/emailTemplatePersonalised";
import type { TaxProfileData } from "./dynamics";

const DEFAULT_SYSTEM_PROMPT =
    "You are a friendly and professional tax advisor at TTT Group. Write warm but concise emails that are easy to understand. Avoid jargon. Do NOT invent or change any numbers — use the exact figures provided.";

const ITA34_SELECT = [
    "riivo_ita34id", "riivo_yearofassessment", "riivo_income",
    "riivo_taxableincomeassessedloss", "riivo_retirementannuityfundcontributions",
    "riivo_retirementfundcontributions", "riivo_providendfundcontributions",
    "riivo_medicalschemefeestaxcredit", "riivo_medicalrebatebelow65withnodisability",
    "riivo_dateofassessment", "riivo_referencenumber",
].join(",");

const IRP5_SELECT = [
    "riivo_irp5id", "riivo_assessmentyearint", "riivo_incomepaye",
    "riivo_grosstaxableincome", "riivo_totaldeductionscontributions",
    "riivo_racontributions", "riivo_providentfundcontributionpaye",
    "riivo_totalprovidentfundcontributions", "riivo_medicalaidcontributions",
    "riivo_medicalschemetaxcredit", "riivo_taxabletravelremuneration",
    "riivo_employertradingothername", "riivo_taxperiodstartdate", "riivo_taxperiodenddate",
].join(",");

async function fetchTaxProfile(contactId: string): Promise<TaxProfileData> {
    const [ita34Res, irp5Res] = await Promise.all([
        dynamicsRequest<{ value: any[] }>(
            `riivo_ita34s?$select=${ITA34_SELECT}&$filter=_riivo_taxpayercontact_value eq '${contactId}'&$orderby=riivo_yearofassessment desc&$top=1`
        ),
        dynamicsRequest<{ value: any[] }>(
            `riivo_irp5s?$select=${IRP5_SELECT}&$filter=_riivo_client_value eq '${contactId}'&$orderby=riivo_assessmentyearint desc&$top=1`
        ),
    ]);

    const ita34 = ita34Res.value[0] || null;
    const irp5 = irp5Res.value[0] || null;

    return {
        contactId,
        ita34: ita34 ? {
            yearOfAssessment: ita34.riivo_yearofassessment ?? 0,
            income: ita34.riivo_income ?? 0,
            taxableIncome: ita34.riivo_taxableincomeassessedloss ?? 0,
            raContributions: ita34.riivo_retirementannuityfundcontributions ?? 0,
            retirementFundContributions: ita34.riivo_retirementfundcontributions ?? 0,
            providentFundContributions: ita34.riivo_providendfundcontributions ?? 0,
            medicalSchemeTaxCredit: ita34.riivo_medicalschemefeestaxcredit ?? 0,
            medicalRebate: ita34.riivo_medicalrebatebelow65withnodisability ?? 0,
            dateOfAssessment: ita34.riivo_dateofassessment ?? null,
            referenceNumber: ita34.riivo_referencenumber ?? null,
        } : null,
        irp5: irp5 ? {
            assessmentYear: irp5.riivo_assessmentyearint ?? 0,
            incomePaye: irp5.riivo_incomepaye ?? 0,
            grossTaxableIncome: irp5.riivo_grosstaxableincome ?? 0,
            totalDeductions: irp5.riivo_totaldeductionscontributions ?? 0,
            raContributions: irp5.riivo_racontributions ?? null,
            providentFundContribution: irp5.riivo_providentfundcontributionpaye ?? 0,
            totalProvidentFund: irp5.riivo_totalprovidentfundcontributions ?? 0,
            medicalAidContributions: irp5.riivo_medicalaidcontributions ?? 0,
            medicalSchemeTaxCredit: irp5.riivo_medicalschemetaxcredit ?? 0,
            taxableTravel: irp5.riivo_taxabletravelremuneration ?? 0,
            employerName: irp5.riivo_employertradingothername ?? null,
            taxPeriodStart: irp5.riivo_taxperiodstartdate ?? null,
            taxPeriodEnd: irp5.riivo_taxperiodenddate ?? null,
        } : null,
    };
}

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
