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
| `Utility - Child - Email Team a Failed-Flow Alert with Run Link` (`6b0bff17-…`) | **on** | The house "tell a human this flow went wrong" child, called by **218 of the org's 322 modern flows** in one shape: alert, then `Terminate` with `runStatus: Failed`. Owns the recipient (`riivo_varFlowErrorTeamMail`, a Teams channel address), the sender (the shared-mailbox queue) and the run link. Reused by #101 for a parked run. |
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

Built in #99. Three things the build settled that the issue did not spell out:

- **Age is recomputed from the invoice's `createdon` on every run**, the same basis the proven
  cadence flow `c430ace5` uses for its step ladder. `riivo_baddebt.riivo_invoiceage` is *not* used:
  it is stamped when the row is created and does not age, so banding on it would freeze a debtor in
  the band they entered at.
- **Relationship is asked as a top-1 existence query** — "does this client have any invoice at
  `statuscode 958140003` (Paid)" — so a client with hundreds of paid invoices costs the same as one
  with a single one. Partially Paid deliberately does **not** count as having paid: the paid-before
  copy opens "it's been great having you as a client", which a part-payment does not earn.
- **An invoice outside the In-scope window has no band, and the client is HELD, not banded into the
  nearest neighbour.** `CONTEXT.md` § In-scope invoice puts the window at older than 30 days and
  younger than three years, and #98's selection query enforces neither bound. Guessing a band would
  put a *prescribed* debt into the 1–3y final-notice copy — precisely the population where an
  acknowledgement revives the debt. Held rows are named in the dry-run report with their reason, so
  a silent client is never a silent failure. **This is the remaining gap in #98's selection query**:
  the hold catches it downstream rather than the query excluding it upstream. Worth closing when the
  prod book (which is mostly legacy debt) comes into view.

**Touch bookkeeping** writes `riivo_campaignsendcount` (read + 1, never a recount) and
`riivo_campaignlastsent` on every touch, and `riivo_campaignfirstsent` on the first only — from a
separate branch, so a later touch's patch cannot carry the field at all. `riivo_campaignbounced` and
`riivo_campaignlastreply` are owned by the bounce and reply paths and appear in neither patch. The
write is gated on a **send outcome**, not on test mode: until #102/#103 land, both channel outcomes
are literally `false`, so turning `riivo_ReminderTestMode` off early advances no counter.

### Message inputs, and the abort

Built in #100, as `Scope_|_Prepare_Documents` inside the per-client loop. Four things the build
settled that the issue did not spell out:

- **The token is written back to the invoice.** The cadence flow `c430ace5`, named as the source to
  copy, mints inline and *drops* the token — so it re-mints on every run. The write-back is taken
  from `9f8601a5` instead, which already owns `riivo_paymenttoken`. Without it the "skip an invoice
  that already has a token" idempotence can never become true.
- **Minting is gated on `riivo_PaymentLinkEnabled`**, as the cadence flow gates it. Every one of the
  24 approved templates carries a Pay-now button, so with links switched off there is no compliant
  message to send: the run holds each client naming that reason, rather than sending a button
  pointing at a switched-off endpoint. The issue did not mention the switch; honouring it means one
  environment variable can silence the campaign, but it does so **visibly**, in the report.
- **No invoice-type gate.** The cadence flow mints only for Tax invoices (`riivo_invoicetype`
  `100000000`); that condition is deliberately not inherited. The dev book is 53 Tax to 7
  Accounting, the PDF child handles both, and every bad-debt template needs a button — so a Tax-only
  path would silently hold every accounting debtor. If the mint endpoint turns out to reject
  accounting invoices, that surfaces as a held client with the endpoint's status in the reason.
- **`Retry-After` is honoured by hand.** Azure documents the retry policy as covering 408/429/5xx
  but says nothing, anywhere, about honouring `Retry-After`, so the default policy retries on its
  own clock. The mint call therefore carries `retryPolicy: none` inside an `Until` that reads the
  header and waits exactly that long, clamped to 300s. The PDF call keeps its default policy on
  purpose: the child's own HTTP action retries `riivo_InvoiceGen2_Endpoint`, which is the layer
  where such a header actually arrives — a child flow's `Response` cannot carry one back.

**The abort** is a handled scope failure, so one client's unproducible document cannot end the run
for the clients behind them in a sequential loop. The gate is "do we *have* both things", not "did
the calls succeed", so a call that failed and a call that returned nothing are treated identically.
An aborted client receives **no bookkeeping patch at all**, which is what makes the next run pick
them up unchanged.

### The volume tripwire

Built in #101, between selection and the per-client loop. Three things about it are worth knowing.

**It sits before the loop, not before the send.** The issue says "before any send", but the loop
mints payment tokens, writes them back to the invoice and renders PDFs in *both* modes — so a
tripwire that only guarded the send would still let an anomalous run make hundreds of function
calls and Dataverse writes. Everything that costs something is downstream of the gate. `Terminate`
ends the run where it stands, so nothing had to be re-nested into a branch to achieve that.

**An aborted run is not a baseline.** The previous count is read from the most recent run whose
outcome is `proceeded` **or** `accepted`, never `aborted`. Without that, the tripwire disarms
itself: a selection that jumped tenfold would park once, record ten times the usual count, and look
perfectly normal on the next run. The cost is that a population which stays anomalous keeps parking
— which is the point. `accepted` is the human's way out, and deliberately a one-field edit on the
parked row rather than a threshold change: raising the threshold to let one run through is exactly
the temporary change that becomes permanent.

**It notifies through the house child, not its own email.** `Utility - Child - Email Team a
Failed-Flow Alert with Run Link` already owns the recipient (`riivo_varFlowErrorTeamMail`), the
sender and the run link, and 218 flows already alert through it — so a parked run lands in the
channel operators already watch. Its `text` and `text_1` inputs are free text it renders verbatim,
which is how the selected count, the previous count and the threshold reach the reader and how the
reason reaches the subject line. This is a **deliberate departure** from the issue's "the
notification target belongs in an environment variable following the `riivo_Reminder*` convention":
the target *is* an environment variable, just the house one, and reproducing the send here would
have cost this build its strongest assertion — that the flow creates no `email` row and performs no
`SendEmail` at all until #102/#103 deliberately add one. A bad-debt-specific address later is one
variable on the child, not a change here.

The run terminates as **Failed**, not Succeeded: a park is something someone must look at, and
Failed makes it red in run history and picked up by the platform's own failure notifications — a
second path to a human if the email does not arrive. The `Terminate` runs after the alert on *any*
status, so an undeliverable courtesy cannot keep a parked run alive.

Two limits, both accepted and both recorded in the code:

- **A zero baseline is unguarded.** A previous run that legitimately selected nobody leaves no
  proportion to measure, so growth from zero proceeds. Parking every restart is worse.
- **The percentage is integer-truncated**, so the comparison is coarse by a fraction of a percent,
  in the direction of proceeding. A threshold measured in tens of percent has no use for the
  difference between 40.9 and 41.

`riivo_BadDebtVolumeChangeThresholdPercent` (String, default 40, following every other numeric
variable in this org) is the only knob. `int()` throws on a non-numeric value, which fails the run
at that compose — upstream of everything — rather than sending with a threshold nobody meant.

### Consent is not optional

D6 sets the *campaign* stop rule to Paid-only; channel consent is separate and enforced regardless:
skip email on `donotemail`/`donotbulkemail`, skip WhatsApp unless `riivo_whatsappoptinout` is opted
in with a valid mobile. A client failing one channel still receives the other.

## Data Model — `riivo_baddebt`

**No new columns are required on `riivo_baddebt`.** Confirmed present in dev: `riivo_campaignlastsent` (DateTime),
`riivo_campaignsendcount` (Integer), `riivo_campaignfirstsent` (DateTime), `riivo_campaignbounced`
(Boolean), `riivo_campaignlastreply` (DateTime), plus `riivo_invoice` and `riivo_client` lookups,
`riivo_outstandingamount`, `riivo_baselineoutstanding`, `riivo_invoiceage` and the bank/EFT fields.

Optional, only if per-channel outcome reporting is wanted: two choice columns for last email and
last WhatsApp result. Not required for the cadence to work.

## Data Model — `riivo_baddebtrun` (new, #101)

**One new table is required**, and it is the only schema this build adds. The volume tripwire
compares a run against the previous one, so the previous count has to outlive the run that produced
it. Declared in `flows/badDebtRunTable.ts` and created by the deploy script from that same module,
so the column names the flow addresses as strings are the column names that exist.

| Column | Type | Why |
|---|---|---|
| `riivo_name` | String (primary) | The run, named by the UTC instant it started. |
| `riivo_selectedcount` | Integer | What this run selected. The next run's baseline. |
| `riivo_previouscount` | Integer | What it was compared against. 0 when there was nothing. |
| `riivo_changepercent` | Integer | The movement, truncated. Stored so a parked row explains itself. |
| `riivo_thresholdpercent` | Integer | The threshold in force, so retuning the variable later does not make an old decision unreadable. |
| `riivo_outcome` | String | `proceeded` \| `aborted` \| `accepted`. |
| `riivo_abortreason` | String | The sentence the alert email carried. |
| `riivo_testmode` | Boolean | Whether this was a rehearsal. Selection does not depend on it, so a rehearsal is a valid baseline; this is how a human tells them apart. |
| `riivo_resolvedcount` / `riivo_heldcount` | Integer | Written after the per-client loop, so null on a parked run. |

Three cheaper stores were considered and rejected. **An environment variable the flow writes
back**: variable *values* are solution-aware rows, so the prod import this build is heading for
would silently reset the baseline. **Recomputing from `riivo_baddebt` bookkeeping**: that records
what was *sent*, not what was *selected*, and records nothing at all for a run that aborted — which
is the run whose count matters most. **`riivo_systemsettings`** (name + integer, already in dev):
no field for the outcome, so the property that makes the tripwire safe could only live in a name
string. `riivo_systemevent` was the other candidate; its `riivo_eventtype` is application-required
with exactly one option, "Document Decryption".

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

**R5 — Partly resolved by #101.** The tool's validation gate, sample preview and hold report are
still out of the path. Now mitigated: no message without its PDF, per-channel consent, the
last-sent guard, and — new — a run-level volume tripwire that parks the run if the selected count
moves more than `riivo_BadDebtVolumeChangeThresholdPercent` (default 40) from the last acted-on
run, or empties out entirely. Still **not** mitigated: a wrong template and a stale balance. Both
are per-recipient faults at the right volume, which is precisely what a count cannot see. The
Statement build's Freshness re-check is the answer to the stale balance; the template is guarded
only by the approved-name check in #99.

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
- **P2 — Template selection.** ✅ Built (#99): campaign-key mapping to the 24 templates, the D12
  fallback past touch 4, and touch bookkeeping gated on a send outcome. Still test mode, still no
  sends. Awaiting the dev replace-deploy and a human test run.
- **P2a — Message inputs.** ✅ Built (#100): per-client token minting with write-back, the invoice
  PDF via the existing child flow, and a clean per-client abort when either cannot be produced.
  Still test mode, still no sends. Rides P2's replace-deploy and human run.
- **P2b — Volume tripwire.** ✅ Built (#101): the run parks itself before producing anything if its
  selected count disagrees with the last acted-on run, and records every run's count on
  `riivo_baddebtrun` either way. Needs the new environment variable and the table, both of which the
  deploy script creates.
- **P3 — Email live.** To colleague addresses, then a small canary.
- **P4 — WhatsApp live.** Same progression.
- **P5 — Schedule and hand over.** Recurrence on in dev, observe two cycles, hand to Luc for prod.

R2, R3 and R4 are settled (D10–D12); none now blocks P5. R1's dev half is measured and its
prod half plus R7 remain open — both are owned by issue #96 and block prod promotion, not the dev
build. R5's run-level half is built as #101; its per-recipient half (wrong template, stale balance)
is not, and is named above.

**Found while building #101, unrelated and unfiled:** the failed-flow alert child `6b0bff17` gates
its send on `riivo_varFlowErrorSendBool` — and **sends in both branches**, `Send_Mail` and
`Do_not_Send_Mail` being identical `SendEmail` calls. Setting that variable to `no` therefore
suppresses nothing, org-wide. For a safety alert that is the fail-safe direction, so #101 does not
work around it; it is worth its own ticket alongside the `2b89f0b5` statuscode bug.
