# Spec: Bad-debt recovery on Power Automate — scheduled, unattended sends

_Status: draft-for-review · Owner: Luc · Created: 2026-09-10 · Revised: 2026-09-10 after dev-org inspection_
_Relates to: `docs/prd-bad-debt-excel-campaign.md` (the tool-driven campaign this automates)_
_Does NOT supersede: `docs/spec-bad-debt-statements.md` (the Statement model, still the target state)_
_Glossary: CONTEXT.md § Bad-debt recovery · Decisions: ADR 0001–0005_

## Problem Statement

Bad-debt recovery runs 1–9 were each driven by hand: export from the CRM, mint tokens, upload a
CSV to the comms tool, pick a WhatsApp template, review the validation report, click send. That is
several hours of operator time per touch, it only happens when someone remembers, and the cadence
has drifted run to run — which is exactly the variable the fatigue analysis needed held constant.

The steps are all mechanical and all of them already exist somewhere: the CRM holds the debtors,
an Azure function mints payment tokens, a second Azure function renders invoice PDFs, and TTT
already has house Power Automate flows that create-and-send Dataverse email rows and push WhatsApp
documents through Meta. Nothing needs inventing; it needs assembling and putting on a timer.

## Solution

**The engine already exists.** Inspection of the dev org (`tttdevelopment.crm4.dynamics.com`)
found `Invoice - Scheduled - Payment Reminder & Link Cadence` — a complete, environment-variable-
driven cadence orchestrator that already performs every one of the five steps this work asked for:
it lists eligible invoices, mints a payment token when one is missing, calls a child flow for the
invoice PDF, and sends branded email, WhatsApp (with the PDF as a document header) and SMS, with
exactly-once delivery guarded by `riivo_lastreminderstep`. It is currently **off** (draft), and its
description calls it "Tracer slice #4" of a `payment-reminder-cadence` build.

Critically, that flow is the **pre-bad-debt** cadence: its filter carries
`riivo_referredtobaddebts ne true`, and at day 30 it *sets* `riivo_referredtobaddebts = true`,
handing the invoice over. So bad-debt recovery is the downstream half of a hand-off that already
exists — not a parallel channel competing with it.

The work is therefore **not to build six new flows**. It is to stand up the bad-debt sibling of a
proven engine: same shape, same child flows, over the referred-to-bad-debt population, on a
twice-weekly recurrence, using the 24 campaign-key templates instead of the two generic ones.

The comms tool is not retired. It keeps the bad-debt path for ad-hoc and manually-curated sends;
Power Automate takes over the routine cadence.

## Decisions Taken

These were settled in the scoping conversation and are the premises the plan rests on.

| # | Decision | Consequence |
|---|---|---|
| D1 | The send happens **in Power Automate**, using the house pattern — create a Dataverse `email` row, then `PerformBoundAction` `SendEmail`. Not the Outlook connector. | The tool's validation gate, batching, Batch Lease, campaign tally and bounce processing are not in the path. Their guarantees must be re-provided or consciously dropped (see Risks). |
| D2 | **Per-invoice now, Statement-shaped later.** | Build against the invoice GUID and per-invoice token, but keep the document source and payment link as single swappable points so the Statement Issue GUID and Statement Link can replace them without a rewrite. |
| D3 | **One message per client per run**, carrying that client's **newest** open invoice — its amount, its PDF, its token. | Message body and Pay-now button always agree. Multi-invoice debtors are chased one invoice at a time. See R4. |
| D4 | **Runs alongside** the existing daily dunning automation. | A debtor can receive the daily reminders *and* this. See R1. |
| D5 | **Fully unattended** — no approval gate. | Nothing catches a bad run before it reaches live debtors. See R5. |
| D6 | Stop rule is **Paid only**. | No promise-to-pay or max-touch brake. Channel consent flags are still honoured unconditionally (see "Consent is not optional"). See R3. |
| D7 | Send state lives on **`riivo_baddebt`**, merged monotonically. | Confirmed against dev: `riivo_campaignlastsent`, `riivo_campaignsendcount`, `riivo_campaignfirstsent`, `riivo_campaignbounced` and `riivo_campaignlastreply` **already exist**. Almost no new schema is needed. |
| D8 | Message content reuses **`Email - Child - Build Branded HTML Email, Create or Send`** and the existing 24 approved Meta templates. | No new Meta template approvals for touches 1–4. See R2. |
| D9 | **All build happens in the dev org** (`tttdevelopment.crm4.dynamics.com`). | Luc promotes dev → prod manually. No agent deploys or activates a flow. |
| D10 | **R4 settled — chase the newest open invoice.** D3 stands as written. | The age band is derived from the newest invoice being chased, which **contradicts `CONTEXT.md` § Campaign key**, where the band is defined against the client's *oldest* In-scope invoice. The contradiction is accepted, not resolved: message, amount, PDF and Pay-now token all agree on one invoice, which is what a client can act on. The cost is accepted too — the oldest invoice keeps ageing toward the three-year prescription line while we message about fresher debt, and template firmness tracks the wrong invoice. Revisit if prescription starts biting. |
| D11 | **R3 settled — the stop rule stays Paid-only.** No promise-to-pay brake in v1. | D6 is unchanged. A client who has promised to pay continues to be chased twice weekly until the payment actually lands and `Invoice - Automated - Close Bad Debt When Invoice Paid` closes the record. This is a **departure from stories 22–23 of `docs/spec-bad-debt-statements.md`**, which treat promise-to-pay suppression as a must; the Statement build owns that. Channel consent flags are still honoured unconditionally. Expect this to be the most likely source of a client complaint. |
| D12 | **R2 settled — after touch 4, fall back to a single general template and keep sending.** | The four campaign-key templates run Day 0 → 10 → 25 → 40; from touch 5 onward every client gets one general reminder template, repeated, rather than the Day-40 final notice repeated or a wrap-around to touch 1. **No new Meta submissions are required** — `riivo_WhatsApp_Template_WithButton` (`ttt_invoice_reminder_paylink_v2`) is already approved and already carries a Pay-now button, so P5 is not blocked on template approval. Consequence to accept: its copy is a *general invoice reminder*, not an arrears message, so tone softens after the Day-40 final notice. The template name is read from an environment variable, never hardcoded, so swapping it for a purpose-written `bad_debt_wa_ongoing` later is a config change. |

## Existing Assets — confirmed in the dev org

All GUIDs and states below were read from `tttdevelopment.crm4.dynamics.com` on 2026-09-10.

| Flow | State | What it gives us |
|---|---|---|
| `Invoice - Scheduled - Payment Reminder & Link Cadence` (`c430ace5-…`) | **off** | The whole engine: eligibility query, step ladder, exactly-once guard, mint, PDF, email, WhatsApp, SMS. The template to clone. |
| `Invoice - Child - Generate PDF` (`be610dd6-…`) | on | `invoiceId` in → base64 PDF out. Builds the Tax/Accounting payload from `riivo_invoicelineitemses`, POSTs to `riivo_InvoiceGen2_Endpoint`. Reuse unchanged. |
| `Email - Child - Build Branded HTML Email, Create or Send` (`0d0bc4d6-…`) | on | Branded HTML body, create `email` row, bound `SendEmail`. Reuse unchanged. |
| `Child Flow - Invoice – Delivery Sub-flow – Email and WhatsApp` (`bffe21f2-…`) | on | Alternative combined delivery child, already using the create-row + `PerformBoundAction` pattern. |
| `Invoice - Automated - Close Bad Debt When Invoice Paid` (`fa37bef7-…`) | on | **The Paid-only stop rule (D6) is already implemented** — sets linked bad-debt records Inactive / "Recovered - Paid" (`463630000`). |
| `Invoice - Scheduled - Create Bad Debt Records for Unpaid Aged Invoices` (`4b3d43cd-…`) | off in dev | The mystery daily `riivo_baddebt` creator. Identified. |
| `Invoice - Scheduled - Bad Debt Referral & Owner Digest` (`dd5a766f-d67d-f111-ab0f-002248a29481`) | off in dev | **Found 2026-09-11; absent from every prior document.** Daily 09:30 SAST. Already carries the exact bad-debt-side eligibility query this build needs (`riivo_referredtobaddebts eq true` + Open/Partially-Paid + `ttt_outstanding gt 0` + createdon floor), a `Compose_\|_TestMode` switch, a dedupe against existing `riivo_baddebt` rows, and an owner-digest email. It is a **second** `riivo_baddebt` creator alongside `4b3d43cd-…`. The closer sibling to clone for the *selection* half. |
| `Invoice – On Create – Mint Token & Push to Xero` (`9f8601a5-…`) | off | A second minting path; the cadence flow mints inline instead. |
| The 24 `bad_debt_wa_*` Meta templates | approved | Document header + dynamic Pay now button, already approved. No new Meta submissions for touches 1–4. |

### How the existing cadence engine works

- **Recurrence**: daily 09:00, `South Africa Standard Time`.
- **Eligibility**: `statecode eq 0 and (statuscode eq 958140000 or statuscode eq 463630001) and ttt_outstanding gt 0 and riivo_referredtobaddebts ne true and createdon ge {floor}`.
- **Step ladder**: env var `riivo_ReminderStepDays` (comma-separated days) → target step is the largest step ≤ invoice age. Sends only when target > `riivo_lastreminderstep`; that comparison is the entire exactly-once guard.
- **Channel gating**: WhatsApp on steps `[3,6,13,24,30]`, SMS on `[4,9,18,30]`, email on every step.
- **Link eligibility**: `riivo_PaymentLinkEnabled` AND invoice type is Tax (`100000000`) AND step ≥ 3 AND payer is not an external marketer.
- **Mint**: `Condition_|_Mint_Needed` → `POST {riivo_PaymentLink_BaseUrl}/mint-token`, then stamps `riivo_paymentlinksenton`.
- **Hand-off**: at day 30 it sets `riivo_referredtobaddebts = true` on the invoice.
- **Test mode**: env var `riivo_ReminderTestMode`.
- **Amount** is `ttt_outstanding` — the live balance, not the invoice's original total.

## External Contracts

**Mint a payment token** (skip any invoice that already has `riivo_paymenttoken`):

```
POST {riivo_PaymentLink_BaseUrl}/mint-token
Header: x-functions-key: {riivo_PaymentLink_FunctionKey}
Body:   { "invoiceId": "<new_invoicesid GUID>" }
→ token → new_invoiceses.riivo_paymenttoken
Client link: {riivo_PaymentLink_BaseUrl}/p/{token}
```

Both values are Dataverse environment variables (confirmed present in dev). Read them from
`environmentvariabledefinitions`; never hardcode. Note the function key is stored as a plaintext
default value on the environment variable — worth reviewing separately.

**Render the invoice PDF** — do not call this directly. Call `Invoice - Child - Generate PDF`,
which owns the payload construction and the `riivo_InvoiceGen2_Endpoint` call.

## Confirmed: `new_invoices` statuscodes

Read from dev metadata. The spec's earlier list was incomplete — there are **six**, and two active
states beyond Open:

| Value | State | Label | Treatment |
|---|---|---|---|
| `958140000` | 0 active | Open | Chaseable |
| `463630001` | 0 active | **Partially Paid** | **Chaseable** — chase `ttt_outstanding`, never the original total |
| `463630002` | 0 active | Payment Received – Pending Settlement | **Never chase** — money is in flight |
| `958140003` | 1 inactive | Paid | Stop (D6) |
| `958140004` | 1 inactive | Cancelled | Never chase |
| `2` | 1 inactive | Inactive | Never chase |

Partially Paid appears nowhere in `docs/spec-bad-debt-statements.md` or the earlier analyses.
Filtering on `statecode eq 0` alone sweeps in Pending Settlement, which is the dangerous one.
The existing cadence flow already gets this right and is the pattern to copy.

## Flow Topology

**Clone, don't invent.** One new scheduled parent, cloned from the cadence orchestrator:

**`Invoice - Scheduled - Send Bad Debt Recovery Touches`**

- Recurrence **Monday and Thursday 09:30 SAST** — offset from the 09:00 reminder flows.
- Eligibility: `riivo_baddebt` rows still open, joined to `new_invoiceses` where
  `statecode eq 0 and (statuscode eq 958140000 or statuscode eq 463630001) and ttt_outstanding gt 0`.
  Pending Settlement, Paid and Cancelled all excluded.
- Collapse to **one row per client**, keeping the **newest** In-scope invoice (D3).
- Step ladder replaced by a **touch counter**: `riivo_campaignsendcount` drives which of the four
  campaign-key templates is used; the guard becomes "last sent more than N days ago" against
  `riivo_campaignlastsent`, rather than the age-based `target > last` comparison.
- Per client: reuse `Invoice - Child - Generate PDF`, the inline mint block, the WhatsApp
  upload-and-send block, and `Email - Child - Build Branded HTML Email, Create or Send`, all
  lifted from the cadence flow.
- Record the touch back onto `riivo_baddebt` (`riivo_campaignlastsent`, `riivo_campaignsendcount`,
  `riivo_campaignfirstsent` on the first touch) — monotonic merge, never a blind overwrite.

### Template selection

Campaign key = **age band** (30–90d / 90d–1yr / 1–3yr) × **relationship** (paid-before /
never-paid) × **touch number** → `bad_debt_wa_{band}_{relationship}_day{N}`. Under D3 the age band
derives from the newest invoice rather than the oldest — a departure from CONTEXT.md's Campaign
key. See R4.

### Consent is not optional

D6 sets the *campaign* stop rule to Paid-only; channel consent is separate and enforced regardless:
skip email on `donotemail`/`donotbulkemail`, skip WhatsApp unless `riivo_whatsappoptinout` is opted
in with a valid mobile. A client failing one channel still receives the other.

## Data Model — `riivo_baddebt`

**No new columns are required.** Confirmed present in dev: `riivo_campaignlastsent` (DateTime),
`riivo_campaignsendcount` (Integer), `riivo_campaignfirstsent` (DateTime), `riivo_campaignbounced`
(Boolean), `riivo_campaignlastreply` (DateTime), plus `riivo_invoice` and `riivo_client` lookups,
`riivo_outstandingamount`, `riivo_baselineoutstanding`, `riivo_invoiceage` and the bank/EFT fields.

Optional, only if per-channel outcome reporting is wanted: two choice columns for last email and
last WhatsApp result. Not required for the cadence to work.

## Scope

**In scope**
- One new scheduled parent flow, cloned from the cadence orchestrator, built and tested in dev.
- Campaign-key template selection over the 24 approved Meta templates.
- Touch bookkeeping on the existing `riivo_baddebt` campaign columns.
- A dry-run mode reusing the `riivo_ReminderTestMode` pattern.
- Rehearsal against the three colleague test invoices (Luc, Nic, Roscoe) per
  `bad-debt-merge-csv-handoff.md`, with `donotemail`/`donotphone` set, then reverted.

**Out of scope**
- The Statement model, Statement Link page and Allocation (`docs/spec-bad-debt-statements.md`).
- Turning on, modifying or retiring `Invoice - Scheduled - Payment Reminder & Link Cadence` — its
  own build owns that.
- Any change to the payment-link or invoice-generator Azure functions, or to
  `Invoice - Child - Generate PDF`.
- Prod promotion — Luc does that manually (D9).
- Retiring the tool's bad-debt path; the run-9 batch-size work on this branch still lands.

## Risks and Open Questions

**R1 — Contact stacking is smaller than feared; dev now measured, prod still unverified.**
The cadence engine and bad-debt recovery are *sequenced*, not parallel: the cadence hands an invoice
over at day 30 by setting `riivo_referredtobaddebts`, and its own filter then excludes it.

*Dev rehearsal, 2026-09-11* (read-only, per the dev-first gate on this question):

- `Invoice - Scheduled - Send Overdue Payment SMS Reminders to Clients on Set Days`
  (`2b89f0b5-…`, **on**, daily 09:00 SAST) has **no** bad-debt exclusion — but it fires on
  `icon_daysactive eq` one of **`[2,4,5,6,7]`**. That window closes on day 7, and the bad-debt
  hand-off happens at day 30. **In dev the stacking from this flow is therefore nil**, not the
  feared overlap. The concern was misplaced for *this* flow.
- The same flow filters on **`statecode eq 0` alone**, with no `statuscode` clause. It therefore
  messages clients in **Payment Received – Pending Settlement (`463630002`)** — money already in
  flight. This is a **pre-existing defect in a live flow**, out of scope here, and worth its own
  ticket.
- `Invoice - Scheduled - Bad Debt Referral & Owner Digest` (`dd5a766f-…`, off in dev) occupies
  **daily 09:30 SAST** — the exact slot this build asked for — and *creates* `riivo_baddebt` rows.
  If it is on in prod, a 09:30 bad-debt send would read the table while that flow is still writing
  it. The new flow's recurrence must clear it.

*Still unverified:* what runs in **prod**. The daily WhatsApp/SMS dunning recorded since
15 July 2026 cannot be explained by the dev SMS flow's day-2-to-7 window, so prod either runs a
different flow, a different day-set, or something outside this inventory. **Resolving R1 requires
the prod read that issue #96 owns; the dev half is now done.**

**R2 — Resolved by D12.** The four-template ladder still runs out in about two weeks at a
twice-weekly cadence, but touch 5 onward now falls back to the already-approved general template
`ttt_invoice_reminder_paylink_v2`, read from `riivo_WhatsApp_Template_WithButton`. No Meta
submission sits on the critical path, so **this no longer blocks going unattended**. Residual: the
general template's copy is a routine reminder rather than an arrears notice, so firmness drops
after the Day-40 final notice instead of holding. Accepted; revisit if late-touch recovery falls.

**R3 — Resolved by D11, against the recommendation.** The stop rule stays Paid-only. The
promise-to-pay filter is *not* built in v1. A client who has promised to pay is chased twice weekly
until the money lands. This contradicts stories 22–23 of `docs/spec-bad-debt-statements.md`, which
the Statement build owns. Flagged as the most likely complaint vector.

**R4 — Resolved by D10, against the recommendation.** Newest-invoice selection stands. The oldest
invoice continues to age toward the three-year prescription line un-chased, and the Campaign key's
age band is derived from the newest invoice — a stated, accepted contradiction of
`CONTEXT.md` § Campaign key rather than an oversight.

**R5 — Nothing catches a bad run (D5).** The tool's validation gate, sample preview and hold report
are out of the path. Mitigated: no message without its PDF, per-channel consent, and the
last-sent guard. Not mitigated: a wrong template, a stale balance, or a selection query returning
10× the usual count. *Strongly recommend* a volume tripwire — abort if the selected count moves
more than ~40% from the previous run.

**R6 — Resolved, and the spec was incomplete.** Statuscodes are confirmed (table above). The new
finding is **Partially Paid (`463630001`), an active state absent from every prior document**. Any
filter written from the older specs would either miss partially-paid debtors or chase clients whose
payment is pending settlement.

**R7 — Service principal permissions.** The dev SP holds System Administrator, which will not exist
in prod. Confirm least-privilege create/write on `riivo_baddebt`, `emails`, and invoice token
fields before promotion.

**R8 — Throughput.** `Apply to each` at default concurrency will trip Meta and Dataverse
service-protection limits at bad-debt volume. Cap concurrency and honour 429s — the cadence flow's
settings are the reference.

**R9 — Measurement spans two systems.** The tool's bad-debt sends run split across a Convex dev
deployment (WhatsApp) and prod (email). Until the tool's bad-debt path stops being used, any
measurement of a run has to account for both plus the new flow.

## Delivery Phases

- **P0 — Ground confirmed.** ✅ Done. Statuscodes, `riivo_baddebt` columns, payment-link environment
  variables, and the existing flow inventory are all verified against dev. Remaining: prod flow
  states (R1) and SP permissions (R7).
- **P1 — Clone and select.** Clone the cadence orchestrator, swap in the bad-debt population and
  the twice-weekly recurrence, run in test mode. Verify its selection against a recipient list the
  tool produces for the same day. No sends.
- **P2 — Template selection.** Campaign-key mapping to the 24 templates, plus touch bookkeeping.
  Still test mode.
- **P3 — Email live.** To colleague addresses, then a small canary.
- **P4 — WhatsApp live.** Same progression.
- **P5 — Schedule and hand over.** Recurrence on in dev, observe two cycles, hand to Luc for prod.

R2, R3 and R4 are settled (D10–D12); none now blocks P5. R1's dev half is measured and its
prod half plus R7 remain open — both are owned by issue #96 and block prod promotion, not the dev
build. R5 is being built as issue #101.
