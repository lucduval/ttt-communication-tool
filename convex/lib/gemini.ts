import { GoogleGenerativeAI } from "@google/generative-ai";

export interface PersonalisedCopy {
    greeting: string;
    closingText: string;
}

export interface TaxScenarioContext {
    recipientName: string;
    yearOfAssessment: number;
    targetYear: number;
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
    const fmt = (n: number): string => {
        const abs = Math.abs(n);
        if (abs >= 1_000_000) {
            const m = abs / 1_000_000;
            const str = m >= 10 ? Math.round(m).toString() : m.toFixed(1).replace(".", ",");
            return `R${str}m`;
        }
        if (abs >= 10_000) return `R${Math.round(abs / 1_000)}k`;
        if (abs >= 1_000) return `R${(abs / 1_000).toFixed(1).replace(".", ",")}k`;
        return `R${Math.round(abs / 100) * 100}`;
    };

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
- Tax Data Year (ITA34): ${scenarios.yearOfAssessment}
- Target Year (the year they are preparing for): ${scenarios.targetYear}
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
  "greeting": "personalised greeting using first name only, e.g. 'Hi [Name],'",
  "closingText": "warm, brief sign-off — 1-2 sentences encouraging them to reach out and speak with a TTT advisor"
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

            if (!parsed.greeting || !parsed.closingText) {
                throw new Error("Gemini response missing required fields");
            }

            // Remove em dashes — they read as AI-generated; replace with commas
            parsed.greeting = parsed.greeting.replace(/\s*—\s*/g, ", ");
            parsed.closingText = parsed.closingText.replace(/\s*—\s*/g, ", ");

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
