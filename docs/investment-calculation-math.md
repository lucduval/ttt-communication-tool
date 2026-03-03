# Investment Calculation Math — AI Personalised Emails

This document explains the exact formulas used to calculate how much a client should invest in their Retirement Annuity (RA) and how much they will accumulate by retirement age 65.

---

## Overview of the Pipeline

```
ITA34 (income, taxable income, current RA)
  + Contact age (from SA ID number or CRM)
        │
        ▼
  1. Max RA deduction cap
  2. Remaining headroom
  3. Three investment options (25% / 50% / 100% of headroom)
  4. Tax saving per option (SA progressive brackets)
  5. Retirement projection per option (compound annuity FV)
        │
        ▼
  AI email with personalised numbers injected by Gemini 2.0 Flash
```

---

## Step 1 — Maximum Allowable RA Deduction

SARS allows a taxpayer to deduct RA + provident fund contributions up to:

```
Max RA Deduction = min(Gross Income × 27.5%,  R350 000)
```

> Source: `calculateMaxRaDeduction()`, line 80–83.

**Example:** Income = R800 000

```
Max RA = min(800 000 × 0.275, 350 000)
       = min(220 000, 350 000)
       = R220 000
```

---

## Step 2 — Remaining Headroom

```
Remaining Headroom = Max RA Deduction − (Current RA + Provident Fund)
```

This is the *unused* tax-deductible space the client has not yet filled.

**Example:** Current RA = R50 000, Max RA = R220 000

```
Headroom = 220 000 − 50 000 = R170 000/year
```

---

## Step 3 — The Three Investment Options

| Option      | Fraction of Headroom | Description                       |
| ----------- | -------------------- | --------------------------------- |
| **A** | 25%                  | Conservative entry point          |
| **B** | 50%                  | Moderate                          |
| **C** | 100%                 | Maximum SARS-allowed contribution |

```
Option A extra annual RA = Headroom × 0.25
Option B extra annual RA = Headroom × 0.50
Option C extra annual RA = Headroom × 1.00

Monthly contribution     = Annual RA ÷ 12
```

> Source: `calculateOptions()`, lines 186–190.

---

## Step 4 — Tax Saving Calculation (SA 2024/2025 Brackets)

The additional RA contribution is **deducted from taxable income**, so the client pays less tax.

### SA 2024/2025 Progressive Tax Brackets

| Taxable Income (R)   | Rate | Base Tax (R) |
| -------------------- | ---- | ------------ |
| 0 – 237 100         | 18%  | 0            |
| 237 101 – 370 500   | 26%  | 42 678       |
| 370 501 – 512 800   | 31%  | 77 362       |
| 512 801 – 673 000   | 36%  | 121 475      |
| 673 001 – 857 900   | 39%  | 179 147      |
| 857 901 – 1 817 000 | 41%  | 251 258      |
| 1 817 001+           | 45%  | 644 489      |

### Rebates (deducted from calculated tax)

| Age      | Rebate  |
| -------- | ------- |
| Under 65 | R17 235 |
| 65 – 74 | +R9 444 |
| 75+      | +R3 145 |

### Tax formula

```
Gross Tax  = Base Tax of bracket + (Taxable Income − Bracket Lower + 1) × Bracket Rate
Tax Payable = max(0, Gross Tax − Rebate)

Tax Saving  = Tax Before − Tax After(new taxable income)
New Taxable Income = Taxable Income − Additional RA Contribution
```

> Source: `calculateTax()`, lines 59–78, and `buildScenario()`, lines 85–108.

---

## Step 5 — Retirement Projection (Future Value of Annuity)

The **additional** RA contribution is assumed to be invested every month until age 65 at a fixed **10% p.a.** growth rate (compounded monthly).

### Formula

```
FV = PMT × [ ((1 + r/12)^(n×12) − 1) / (r/12) ]
```

| Symbol   | Meaning                                          |
| -------- | ------------------------------------------------ |
| `FV`   | Projected value at retirement                    |
| `PMT`  | Monthly contribution (= Annual RA ÷ 12)         |
| `r`    | Annual growth rate =**0.10** (10%)         |
| `n`    | Years to retirement =**65 − current age** |
| `r/12` | Monthly growth rate = 0.008333…                 |

> This is a standard **ordinary annuity** formula (contributions at end of each month).
> Source: `futureValueAnnuity()`, lines 142–150.

---

## Worked Examples

### Example 1 — Mid-career (Age 40, Income R800 000)

**Inputs from ITA34**

| Field                    | Value        |
| ------------------------ | ------------ |
| Gross income             | R800 000     |
| Taxable income           | R650 000     |
| Current RA contributions | R50 000/year |
| Age                      | 40           |

**Step 1–2: Headroom**

```
Max RA  = min(800 000 × 27.5%, 350 000) = R220 000
Headroom = 220 000 − 50 000             = R170 000
```

**Step 3: Options**

```
Option A = 170 000 × 25% = R42 500/year  →  R3 542/month
Option B = 170 000 × 50% = R85 000/year  →  R7 083/month
Option C = 170 000 ×100% = R170 000/year → R14 167/month
```

**Step 4: Tax saving**

Tax before (taxable income = R650 000, bracket 4 @ 36%):

```
Gross Tax = 121 475 + (650 000 − 512 801 + 1) × 0.36
          = 121 475 + 137 200 × 0.36
          = 121 475 + 49 392 = R170 867
Tax Payable = 170 867 − 17 235 (primary rebate) = R153 632
```

| Option | New Taxable Income | Tax After | Annual Tax Saving |
| ------ | ------------------ | --------- | ----------------- |
| A      | R607 500           | R138 332  | **R15 300** |
| B      | R565 000           | R123 032  | **R30 600** |
| C      | R480 000           | R94 072   | **R59 560** |

**Step 5: Retirement projection** (25 years to age 65, 10% p.a.)

```
Monthly rate  = 0.10 / 12  = 0.008333
Months        = 25 × 12    = 300
FV factor     = (1.008333^300 − 1) / 0.008333  ≈ 1 326.7
```

| Option | Monthly PMT | Projected Value at 65 |
| ------ | ----------- | --------------------- |
| A      | R3 542      | **R4 699 202**  |
| B      | R7 083      | **R9 398 403**  |
| C      | R14 167     | **R18 796 807** |

---

### Example 2 — Early career (Age 30, Income R500 000)

**Inputs from ITA34**

| Field                    | Value        |
| ------------------------ | ------------ |
| Gross income             | R500 000     |
| Taxable income           | R420 000     |
| Current RA contributions | R20 000/year |
| Age                      | 30           |

**Headroom**

```
Max RA   = min(500 000 × 27.5%, 350 000) = R137 500
Headroom = 137 500 − 20 000              = R117 500
```

**Options**

```
Option A = 117 500 × 25% = R29 375/year  →  R2 448/month
Option B = 117 500 × 50% = R58 750/year  →  R4 896/month
```

**Tax saving** (taxable income = R420 000, bracket 2 @ 26%)

```
Tax Before = 42 678 + (420 000 − 237 101 + 1) × 0.26 − 17 235 = R75 472
```

| Option | Annual Tax Saving |
| ------ | ----------------- |
| A      | **R9 106**  |
| B      | **R17 750** |

**Retirement projection** (35 years to age 65, 10% p.a.)

The longer time horizon makes a dramatic difference due to compounding:

```
Months = 35 × 12 = 420
FV factor = (1.008333^420 − 1) / 0.008333 ≈ 3 770.0
```

| Option | Monthly PMT | Projected Value at 65 |
| ------ | ----------- | --------------------- |
| A      | R2 448      | **R9 293 854**  |
| B      | R4 896      | **R18 587 707** |

> Starting 10 years earlier (age 30 vs 40) with a smaller Option A amount (R2 448/month vs R3 542/month) produces a **larger** retirement fund — demonstrating the power of time.

---

### Example 3 — Near-retirement (Age 55, Income R1 200 000)

**Inputs from ITA34**

| Field                    | Value         |
| ------------------------ | ------------- |
| Gross income             | R1 200 000    |
| Taxable income           | R950 000      |
| Current RA contributions | R150 000/year |
| Age                      | 55            |

**Headroom**

```
Max RA   = min(1 200 000 × 27.5%, 350 000) = R330 000  (cap applies)
Headroom = 330 000 − 150 000               = R180 000
```

**Options**

```
Option A = 180 000 × 25% = R45 000/year  →  R3 750/month
Option B = 180 000 × 50% = R90 000/year  →  R7 500/month
```

**Tax saving** (taxable income = R950 000, bracket 6 @ 41%)

```
Tax Before = 251 258 + (950 000 − 857 901 + 1) × 0.41 − 17 235 = R271 784
```

| Option | Annual Tax Saving |
| ------ | ----------------- |
| A      | **R18 450** |
| B      | **R36 900** |

**Retirement projection** (only 10 years to age 65, 10% p.a.)

```
Months    = 10 × 12 = 120
FV factor = (1.008333^120 − 1) / 0.008333 ≈ 204.8
```

| Option | Monthly PMT | Projected Value at 65 |
| ------ | ----------- | --------------------- |
| A      | R3 750      | **R768 169**    |
| B      | R7 500      | **R1 536 337**  |

> Despite a higher income (and thus larger headroom), the short time horizon limits the compounding effect. The story for this client centres more on the **immediate tax saving** than the retirement multiplier.

---

## Key Assumptions & Constants

| Parameter         | Value                   | Source                                            |
| ----------------- | ----------------------- | ------------------------------------------------- |
| Retirement age    | 65                      | Hard-coded in `calculateRetirementProjection()` |
| Growth rate       | 10% p.a.                | Default parameter, compounded monthly             |
| RA deduction cap  | R350 000/year           | SARS limit,`RA_DEDUCTION_CAP`                   |
| RA deduction rate | 27.5% of gross income   | SARS limit,`RA_DEDUCTION_RATE`                  |
| Tax year          | 2024/2025               | `TAX_BRACKETS` array                            |
| Compounding       | Monthly (end of period) | Ordinary annuity formula                          |

---

## What the Email Shows

- **Option A card** — monthly RA amount, annual tax saving, projected value at 65
- **Option B card** — same, more aggressive
- **Option C card** — "Personalised Plan" call-to-action only (no numbers), always directs to TTT advisor

Retirement value is displayed as `"Extra at 65 (Nyr @ 10%)"` and only shown when the client's age can be determined from their SA ID number or CRM record.
