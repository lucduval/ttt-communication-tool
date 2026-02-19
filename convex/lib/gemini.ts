import { GoogleGenerativeAI } from "@google/generative-ai";

export interface PersonalisedCopy {
    greeting: string;
    introText: string;
    optionACopy: string;
    optionBCopy: string;
    optionCCopy: string;
    closingText: string;
}

export interface TaxScenarioContext {
    recipientName: string;
    yearOfAssessment: number;
    currentIncome: number;
    currentTaxableIncome: number;
    currentRaContribution: number;
    maxAllowableRa: number;
    currentTaxLiability: number;
    optionA: { additionalRa: number; monthlyRa: number; taxSaving: number; newTaxLiability: number };
    optionB: { additionalRa: number; monthlyRa: number; taxSaving: number; newTaxLiability: number };
    optionC: { additionalRa: number; monthlyRa: number; taxSaving: number; newTaxLiability: number };
    retirementProjection?: {
        currentAge: number;
        yearsToRetirement: number;
        growthRate: number;
        projectedValueA: number;
        projectedValueB: number;
        projectedValueC: number;
    };
}

function getGeminiClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is not configured");
    }
    return new GoogleGenerativeAI(apiKey);
}

function buildPrompt(
    systemPrompt: string,
    userPrompt: string,
    scenarios: TaxScenarioContext
): string {
    const fmt = (n: number) => `R${Math.round(n).toLocaleString("en-ZA")}`;

    const rp = scenarios.retirementProjection;
    const retirementBlock = rp
        ? `
RETIREMENT PROJECTION (10% p.a. growth to age 65):
- Client's Current Age: ${rp.currentAge}
- Years Until Retirement (65): ${rp.yearsToRetirement}
- Option A projected extra at 65: ${fmt(rp.projectedValueA)}
- Option B projected extra at 65: ${fmt(rp.projectedValueB)}`
        : "";

    return `${systemPrompt}

${userPrompt}

RECIPIENT CONTEXT (use these exact numbers — do NOT invent or change any figures):
- Name: ${scenarios.recipientName}
- Tax Year: ${scenarios.yearOfAssessment}
- Total Income: ${fmt(scenarios.currentIncome)}
- Taxable Income: ${fmt(scenarios.currentTaxableIncome)}
- Current RA Contribution: ${fmt(scenarios.currentRaContribution)}
- Maximum Allowable RA Deduction: ${fmt(scenarios.maxAllowableRa)}
- Current Tax Liability: ${fmt(scenarios.currentTaxLiability)}

OPTION A (Moderate Top-Up):
- Monthly RA Contribution: ${fmt(scenarios.optionA.monthlyRa)}/month (${fmt(scenarios.optionA.additionalRa)}/year)
- Annual Tax Saving: ${fmt(scenarios.optionA.taxSaving)}

OPTION B (Accelerated Growth):
- Monthly RA Contribution: ${fmt(scenarios.optionB.monthlyRa)}/month (${fmt(scenarios.optionB.additionalRa)}/year)
- Annual Tax Saving: ${fmt(scenarios.optionB.taxSaving)}

OPTION C (Personalised Plan — call TTT):
- Do NOT include any specific contribution amounts, tax saving figures, or projected values for Option C.
- Instead, explain that TTT can find the perfect plan tailored to the client's unique situation.
${retirementBlock}

IMPORTANT: For Options A and B, frame all RA contribution amounts in MONTHLY terms (per month). The tax saving is annual.${rp ? " When retirement projections are available, reference how much extra the client could have at 65 for Options A and B — this is a powerful motivator. Use the exact projected figures." : ""} For Option C, do NOT include any numbers — only describe how TTT can help.

Respond ONLY with valid JSON matching this exact structure (no markdown, no code fences):
{
  "greeting": "personalised greeting using first name",
  "introText": "Multi-paragraph HTML content for the email intro. Write 4-5 short paragraphs separated by <br><br>. Paragraph 1: reference the start of the new ${scenarios.yearOfAssessment} tax year as a full year of opportunity to structure finances strategically. Paragraph 2: mention that TTT Financial Group believes in proactive — not reactive — tax planning, and in using every available mechanism to legally minimise tax and accelerate long-term wealth creation. Paragraph 3: reference that the scenarios were prepared using figures from the client's most recent ITA34, then include a <ul style=\\"margin:12px 0 0 0;padding-left:20px;\\"> with three <li style=\\"margin-bottom:6px;\\"> items: (1) how much tax they could save this year, (2) what the real net cost would be after SARS effectively subsidises part of their contribution, (3) the long-term wealth impact of acting now rather than later. Paragraph 4: mention that for many clients the outcome is compelling — redirecting money that would have gone to tax into a growing retirement asset. Paragraph 5: a warm invitation to walk through the numbers and show exactly how this could work in their favour${rp ? ` — reference their ${rp.yearsToRetirement} years to retirement` : ""}. Do NOT use markdown or code fences — return only the HTML content string.",
  "optionACopy": "2-3 sentences describing Option A — frame the RA contribution as a monthly amount, the tax saving as annual${rp ? ", and mention the projected extra at 65" : ""}",
  "optionBCopy": "2-3 sentences describing Option B — frame the RA contribution as a monthly amount, the tax saving as annual${rp ? ", and mention the projected extra at 65" : ""}",
  "optionCCopy": "1-2 sentences for Option C — do NOT mention any specific numbers, contributions, or tax savings. Instead, explain that TTT's advisors can create a personalised plan tailored to their unique financial situation to maximise their tax savings and retirement growth. Encourage them to call TTT.",
  "closingText": "warm sign-off"
}`;
}

export async function generatePersonalisedCopy(params: {
    systemPrompt: string;
    userPrompt: string;
    scenarios: TaxScenarioContext;
}): Promise<PersonalisedCopy> {
    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = buildPrompt(params.systemPrompt, params.userPrompt, params.scenarios);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            const text = result.response.text();

            const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
            const parsed = JSON.parse(cleaned) as PersonalisedCopy;

            if (!parsed.greeting || !parsed.introText || !parsed.optionACopy || !parsed.optionBCopy || !parsed.optionCCopy || !parsed.closingText) {
                throw new Error("Gemini response missing required fields");
            }

            return parsed;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < 3) {
                const isRateLimit =
                    lastError.message.toLowerCase().includes("429") ||
                    lastError.message.toLowerCase().includes("quota") ||
                    lastError.message.toLowerCase().includes("rate limit") ||
                    lastError.message.toLowerCase().includes("resource exhausted");
                // Rate limit: wait much longer (15s, 30s, 60s). Other errors: standard backoff (2s, 4s, 8s).
                const delayMs = isRateLimit
                    ? 15000 * Math.pow(2, attempt)
                    : 2000 * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }

    throw new Error(`Gemini generation failed after 4 attempts: ${lastError?.message}`);
}
