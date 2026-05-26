import Anthropic from "@anthropic-ai/sdk";

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

const MODEL = "claude-opus-4-7";

function getClient(): Anthropic {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not configured");
    }
    return new Anthropic({ apiKey, maxRetries: 4 });
}

function fmt(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) {
        const m = abs / 1_000_000;
        const str = m >= 10 ? Math.round(m).toString() : m.toFixed(1).replace(".", ",");
        return `R${str}m`;
    }
    if (abs >= 10_000) return `R${Math.round(abs / 1_000)}k`;
    if (abs >= 1_000) return `R${(abs / 1_000).toFixed(1).replace(".", ",")}k`;
    return `R${Math.round(abs / 100) * 100}`;
}

function buildCachedPrefix(systemPrompt: string, userPrompt: string): string {
    return `${systemPrompt}

${userPrompt}

IMPORTANT: For Options A and B, frame all RA contribution amounts in MONTHLY terms (per month). The additional tax refund is annual. When retirement projections are available, reference how much extra the client could have at 65 for Options A and B — this is a powerful motivator. Use the exact projected figures. For Option C, do NOT include any specific contribution amounts, tax saving figures, or projected values — only describe how TTT can help tailor a plan to the client's unique situation.

You will receive recipient-specific tax data below and must return a personalised greeting and a warm closing sign-off as structured JSON.`;
}

function buildRecipientMessage(scenarios: TaxScenarioContext): string {
    const rp = scenarios.retirementProjection;
    const retirementBlock = rp
        ? `

RETIREMENT PROJECTION (10% p.a. growth to age 65):
- Client's Current Age: ${rp.currentAge}
- Years Until Retirement (65): ${rp.yearsToRetirement}
- Option A projected extra at 65: ${fmt(rp.projectedValueA)}
- Option B projected extra at 65: ${fmt(rp.projectedValueB)}`
        : "";

    return `RECIPIENT CONTEXT (use these exact numbers — do NOT invent or change any figures):
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
- Additional Tax Refund: ${fmt(scenarios.optionA.taxSaving)}

OPTION B (Accelerated Growth):
- Monthly RA Contribution: ${fmt(scenarios.optionB.monthlyRa)}/month (${fmt(scenarios.optionB.additionalRa)}/year)
- Additional Tax Refund: ${fmt(scenarios.optionB.taxSaving)}

OPTION C (Personalised Plan — call TTT):
- Do NOT include any specific contribution amounts, tax saving figures, or projected values for Option C.${retirementBlock}

Return a JSON object with "greeting" (personalised, first-name only, e.g. "Hi Alex,") and "closingText" (warm, brief 1-2 sentence sign-off encouraging them to reach out to a TTT advisor).`;
}

const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        greeting: {
            type: "string",
            description: "Personalised greeting using first name only, e.g. 'Hi Alex,'",
        },
        closingText: {
            type: "string",
            description: "Warm, brief 1-2 sentence sign-off encouraging them to speak with a TTT advisor",
        },
    },
    required: ["greeting", "closingText"],
    additionalProperties: false,
} as const;

export async function generatePersonalisedCopy(params: {
    systemPrompt: string;
    userPrompt: string;
    scenarios: TaxScenarioContext;
}): Promise<PersonalisedCopy> {
    const client = getClient();

    // The system prompt + user template are identical across every recipient in a
    // campaign, so we put them in `system` with cache_control. Only the per-recipient
    // tax context varies, so that goes in the user message.
    //
    // Caching requires the cached prefix to exceed the model's minimum token threshold
    // (4096 for Opus 4.7). Shorter prefixes will still work correctly — they just
    // won't benefit from the ~90% cost reduction on cache reads.
    const cachedPrefix = buildCachedPrefix(params.systemPrompt, params.userPrompt);
    const recipientMessage = buildRecipientMessage(params.scenarios);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await client.messages.create({
                model: MODEL,
                max_tokens: 1024,
                system: [
                    { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
                ],
                messages: [{ role: "user", content: recipientMessage }],
                output_config: {
                    format: { type: "json_schema", schema: RESPONSE_SCHEMA },
                },
            });

            const textBlock = response.content.find(
                (b): b is Anthropic.TextBlock => b.type === "text"
            );
            if (!textBlock) {
                throw new Error("Claude response contained no text block");
            }

            const parsed = JSON.parse(textBlock.text) as PersonalisedCopy;
            if (!parsed.greeting || !parsed.closingText) {
                throw new Error("Claude response missing required fields");
            }

            // Em dashes read as AI-generated — replace with commas.
            parsed.greeting = parsed.greeting.replace(/\s*—\s*/g, ", ");
            parsed.closingText = parsed.closingText.replace(/\s*—\s*/g, ", ");

            return parsed;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // The SDK's built-in maxRetries handles 429 / 5xx / overloaded with
            // proper respect for retry-after. Only retry here on parse / schema
            // failures, which should be rare given structured outputs.
            const msg = lastError.message;
            const isParseError =
                msg.includes("JSON") ||
                msg.includes("missing required fields") ||
                msg.includes("no text block");
            if (!isParseError) throw lastError;
            if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
        }
    }

    throw new Error(`Claude generation failed after retries: ${lastError?.message}`);
}
