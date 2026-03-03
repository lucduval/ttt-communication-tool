import type { TaxProfileData } from "../actions/dynamics";

// SA 2024/2025 Tax Year brackets
const TAX_BRACKETS = [
    { lower: 0, upper: 237_100, rate: 0.18, base: 0 },
    { lower: 237_101, upper: 370_500, rate: 0.26, base: 42_678 },
    { lower: 370_501, upper: 512_800, rate: 0.31, base: 77_362 },
    { lower: 512_801, upper: 673_000, rate: 0.36, base: 121_475 },
    { lower: 673_001, upper: 857_900, rate: 0.39, base: 179_147 },
    { lower: 857_901, upper: 1_817_000, rate: 0.41, base: 251_258 },
    { lower: 1_817_001, upper: Infinity, rate: 0.45, base: 644_489 },
];

// Primary rebate (under 65)
const PRIMARY_REBATE = 17_235;
const SECONDARY_REBATE = 9_444; // 65-74
const TERTIARY_REBATE = 3_145; // 75+

const RA_DEDUCTION_RATE = 0.275; // 27.5%
const RA_DEDUCTION_CAP = 350_000;

export interface RetirementProjection {
    currentAge: number;
    yearsToRetirement: number;
    growthRate: number;
    projectedValueA: number;
    projectedValueB: number;
    projectedValueC: number;
}

export interface TaxScenario {
    additionalRaContribution: number;
    monthlyAdditionalRa: number;
    totalRaContribution: number;
    newTaxableIncome: number;
    taxBefore: number;
    taxAfter: number;
    taxSaving: number;
    effectiveRateBefore: number;
    effectiveRateAfter: number;
}

export interface CalculatedOptions {
    currentSituation: {
        income: number;
        taxableIncome: number;
        taxLiability: number;
        currentRa: number;
        maxAllowableRa: number;
        remainingHeadroom: number;
    };
    optionA: TaxScenario;
    optionB: TaxScenario;
    optionC: TaxScenario;
    yearOfAssessment: number;
    retirementProjection: RetirementProjection | null;
}

export function calculateTax(taxableIncome: number, age: number = 30): number {
    if (taxableIncome <= 0) return 0;

    let tax = 0;
    for (const bracket of TAX_BRACKETS) {
        if (taxableIncome >= bracket.lower) {
            if (taxableIncome <= bracket.upper) {
                tax = bracket.base + (taxableIncome - bracket.lower + 1) * bracket.rate;
                break;
            }
        }
    }

    // Apply rebates
    let rebate = PRIMARY_REBATE;
    if (age >= 65) rebate += SECONDARY_REBATE;
    if (age >= 75) rebate += TERTIARY_REBATE;

    return Math.max(0, Math.round(tax - rebate));
}

export function calculateMaxRaDeduction(income: number): number {
    const maxByPercentage = income * RA_DEDUCTION_RATE;
    return Math.min(maxByPercentage, RA_DEDUCTION_CAP);
}

function buildScenario(
    currentTaxableIncome: number,
    currentRa: number,
    additionalRa: number,
    taxBefore: number,
    income: number
): TaxScenario {
    const totalRa = currentRa + additionalRa;
    const newTaxableIncome = Math.max(0, currentTaxableIncome - additionalRa);
    const taxAfter = calculateTax(newTaxableIncome);
    const taxSaving = taxBefore - taxAfter;

    return {
        additionalRaContribution: Math.round(additionalRa),
        monthlyAdditionalRa: Math.round(additionalRa / 12),
        totalRaContribution: Math.round(totalRa),
        newTaxableIncome: Math.round(newTaxableIncome),
        taxBefore,
        taxAfter,
        taxSaving: Math.round(taxSaving),
        effectiveRateBefore: income > 0 ? Math.round((taxBefore / income) * 10000) / 100 : 0,
        effectiveRateAfter: income > 0 ? Math.round((taxAfter / income) * 10000) / 100 : 0,
    };
}

/**
 * Parse a South African ID number (YYMMDD GSSS C A Z) to extract date of birth
 * and calculate current age.
 */
export function parseAgeFromIdNumber(idNumber: string): number | null {
    const cleaned = idNumber.replace(/\s/g, "");
    if (cleaned.length < 6 || !/^\d{6,13}$/.test(cleaned)) return null;

    const yy = parseInt(cleaned.substring(0, 2), 10);
    const mm = parseInt(cleaned.substring(2, 4), 10);
    const dd = parseInt(cleaned.substring(4, 6), 10);

    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

    const currentYear = new Date().getFullYear();
    const cutoff = currentYear % 100;
    const century = yy > cutoff ? 1900 : 2000;
    const birthYear = century + yy;

    const today = new Date();
    let age = today.getFullYear() - birthYear;
    const birthdayThisYear = new Date(today.getFullYear(), mm - 1, dd);
    if (today < birthdayThisYear) age--;

    return age >= 0 && age <= 120 ? age : null;
}

/**
 * Future value of an ordinary annuity with monthly compounding.
 * FV = PMT × [((1 + r/12)^(n*12) − 1) / (r/12)]
 * Assumes monthly contributions made at the end of each month.
 */
function futureValueAnnuity(annualPayment: number, rate: number, years: number): number {
    if (years <= 0 || rate <= 0) return annualPayment * Math.max(years, 0);

    const monthlyRate = rate / 12;
    const months = years * 12;
    const monthlyPayment = annualPayment / 12;

    return monthlyPayment * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
}

export function calculateRetirementProjection(
    optionA: number,
    optionB: number,
    optionC: number,
    currentAge: number,
    growthRate: number = 0.10
): RetirementProjection | null {
    const yearsToRetirement = 65 - currentAge;
    if (yearsToRetirement <= 0) return null;

    return {
        currentAge,
        yearsToRetirement,
        growthRate,
        projectedValueA: Math.round(futureValueAnnuity(optionA, growthRate, yearsToRetirement)),
        projectedValueB: Math.round(futureValueAnnuity(optionB, growthRate, yearsToRetirement)),
        projectedValueC: Math.round(futureValueAnnuity(optionC, growthRate, yearsToRetirement)),
    };
}

export function calculateOptions(taxProfile: TaxProfileData, age?: number | null): CalculatedOptions {
    const ita34 = taxProfile.ita34;
    if (!ita34) {
        throw new Error("No ITA34 data available for tax calculation");
    }

    const income = ita34.income;
    const taxableIncome = ita34.taxableIncome;
    const currentRa = Math.abs(ita34.raContributions) + Math.abs(ita34.providentFundContributions);
    const maxAllowableRa = calculateMaxRaDeduction(income);
    const remainingHeadroom = Math.max(0, maxAllowableRa - currentRa);
    const taxBefore = calculateTax(taxableIncome);

    // Option A: 25% of remaining headroom (conservative entry point)
    const optionAAdditional = Math.round(remainingHeadroom * 0.25);
    // Option B: 50% of remaining headroom (moderate)
    const optionBAdditional = Math.round(remainingHeadroom * 0.5);
    // Option C: 100% of remaining headroom
    const optionCAdditional = Math.round(remainingHeadroom);

    const optionAScenario = buildScenario(taxableIncome, currentRa, optionAAdditional, taxBefore, income);
    const optionBScenario = buildScenario(taxableIncome, currentRa, optionBAdditional, taxBefore, income);
    const optionCScenario = buildScenario(taxableIncome, currentRa, optionCAdditional, taxBefore, income);

    const retirementProjection = age != null
        ? calculateRetirementProjection(
            optionAScenario.additionalRaContribution,
            optionBScenario.additionalRaContribution,
            optionCScenario.additionalRaContribution,
            age,
        )
        : null;

    return {
        currentSituation: {
            income: Math.round(income),
            taxableIncome: Math.round(taxableIncome),
            taxLiability: taxBefore,
            currentRa: Math.round(currentRa),
            maxAllowableRa: Math.round(maxAllowableRa),
            remainingHeadroom: Math.round(remainingHeadroom),
        },
        optionA: optionAScenario,
        optionB: optionBScenario,
        optionC: optionCScenario,
        yearOfAssessment: ita34.yearOfAssessment,
        retirementProjection,
    };
}
