# Handoff: bad-debt recovery on Power Automate

_Written 2026-09-11 · Covers issues #96–#104 · Spec: `docs/spec-bad-debt-power-automate.md`_

Read this plus the spec and you can pick up cold. Everything below was verified
against the dev org on 2026-09-11 unless it says otherwise.

---

## Where the work stands

| Issue | State |
|---|---|
| #96 Prod flow inventory + SP permissions | **Open.** Dev half done and commented on the issue; prod half untouched. |
| #97 Cadence policy | **Closed.** Decisions recorded as D10–D12 in the spec. |
| #98 Selection, dry run only | **Open but built and deployed.** Two ACs need a human run. |
| #99 Template resolution + touch bookkeeping | **Open but built.** Needs the replace-deploy and a human run. |
| #100 Token minting + PDF | **Open but built.** Rides the same replace-deploy and human run as #99. |
| #101 Volume tripwire | **Open but built.** Rides the same replace-deploy; also needs one new environment variable and one new table, both of which the deploy script creates. |
| #102 Email live | **Open but built.** Rides the same replace-deploy; adds one environment variable and two columns to the run table, both of which the deploy script creates. The rehearsal and the canary are human runs. |
| #103 WhatsApp live | **Open but built.** Rides the same replace-deploy; adds one more run-table column and reads three Meta environment variables that already exist. The rehearsal and the canary are human runs — and unlike email there is **no draft mode**, so the first one sends real messages. |
| #104 Recurrence on, two cycles observed | **Open; the buildable half is built.** Adds the kill switch, the run clock and the throttle counter, plus `docs/runbook-bad-debt-recovery.md`. Rides the same replace-deploy; adds one environment variable and three run-table columns, both of which the deploy script creates. Everything else it asks for is human: switching the recurrence on, watching two cycles, reviewing the threshold against real numbers, and the prod handover. |

**DEPLOYED 2026-09-14: dev now carries the #104 definition.** The one
`--replace` that had been outstanding since #100 ran, so #100–#104 landed
together — the mint/PDF scope, the tripwire, the email channel, the canary, the
WhatsApp channel and the kill switch. Verified against the org the same day:

| | |
|---|---|
| Flow | **`e4128910-18b0-f111-aaac-000d3a667755`**, draft / off, `clientdata` byte-identical to the module. One row with this name; `3c600c0b-…` (the #99 row) and `7d112cdb-…` (the #98 row) are both gone |
| `riivo_baddebtrun` | exists, all **16** declared columns present (plus the auto primary key and the `riivo_testmodename` Dataverse creates for the Boolean) |
| `riivo_BadDebtEnabled` · `riivo_BadDebtCanaryContactIds` · `riivo_BadDebtVolumeChangeThresholdPercent` | created, at defaults `yes` · empty · `40`, no values set |

The deploy took three attempts and neither failure was in the flow — see
"What the deploy itself taught us" below. **Nothing has been run yet**: the
flow is draft/off and no `riivo_baddebtrun` row exists.

**#99, #100 and #101 all say "Blocked by #98".** That dependency is satisfied:
#98's build is deployed and verified. Only its two human-verification ACs
remain, and none of the downstream work depends on them.

---

## Connecting to the dev org

Everything runs against **`https://tttdevelopment.crm4.dynamics.com`**.
`ttt-financial-group2.crm4.dynamics.com` is a legacy alias for the *same dev
org* — it is not prod.

Credentials are a service principal in `~/ttt-automations-update/.env`
(`DYNAMICS_TENANT_ID`, `DYNAMICS_CLIENT_ID`, `DYNAMICS_CLIENT_SECRET`). That
file holds multi-line HTML values, so `source .env` **fails** — grep each var
individually. The full recipe is in
`~/ttt-automations-update/dynamics-connection-guide.md` §3; the SP should come
back as `7229f676-afd5-f011-8544-000d3adca789` from `WhoAmI`.

### Traps that cost time here

- **Page the `workflows` query.** An unpaged request returns exactly 200 rows
  and looks complete. Dev has **321** modern flows, and the truncated tail
  contained a flow the spec already depended on. Use
  `Prefer: odata.maxpagesize=500` and follow `@odata.nextLink`.
- **`clientdata` cannot be PATCHed** — it fails `ConnectionAuthorizationFailed`
  because the SP does not own the connection. To edit a flow: POST the new one,
  verify, then delete the old. That mints a new `workflowid`; update references.
- **An agent cannot activate a flow or run one on demand.** Ownership and
  activation are connection-gated to riivo Admin. `PATCH ownerid` and `Assign`
  are both blocked. Anything needing a *run* is a human step.
- **Dataverse writes are blocked by the Claude Code permission classifier** in
  the default mode, including via the `update-config` skill — an agent cannot
  grant itself the permission, by design. Luc ran the #98 deploy himself.

---

## What exists in dev (state at handoff)

| Flow | GUID | State |
|---|---|---|
| `Invoice - Scheduled - Send Bad Debt Recovery Touches` **(ours)** | `e4128910-18b0-f111-aaac-000d3a667755` | draft / **off** — carries the **#104** definition as of 2026-09-14. The guid changes on every `--replace`, because `clientdata` cannot be PATCHed; `3c600c0b-…` (#99) and `7d112cdb-…` (#98) are gone. |
| `Invoice - Scheduled - Payment Reminder & Link Cadence` | `c430ace5-c57b-f111-ab0f-000d3ada6ac0` | off |
| `Invoice - Scheduled - Bad Debt Referral & Owner Digest` | `dd5a766f-d67d-f111-ab0f-002248a29481` | off |
| `Invoice - Child - Generate PDF` | `be610dd6-bf7b-f111-ab0f-000d3ada6ac0` | **on** |
| `Email - Child - Build Branded HTML Email, Create or Send` | `0d0bc4d6-7f74-f111-ab0e-000d3ada6ac0` | **on** — the house email child; #102 sends through it. 39 flows call it, 16 of them on |
| `Invoice - Automated - Close Bad Debt When Invoice Paid` | `fa37bef7-668a-f111-ab10-002248a29481` | **on** |
| `Invoice - Scheduled - Send Overdue Payment SMS Reminders...` | `2b89f0b5-a9c7-eb11-bacc-000d3ab7951b` | **on** |
| `Utility - Child - Email Team a Failed-Flow Alert with Run Link` | `6b0bff17-e79b-ed11-aad1-000d3ab479cf` | **on** — the house alert child, used by 218 of 322 flows; #101's park notifies through it |

Environment variables that matter:

| Variable | Value |
|---|---|
| `riivo_PaymentLink_BaseUrl` | `https://payment-link-ttt.azurewebsites.net` |
| `riivo_PaymentLink_FunctionKey` | (secret, plaintext default value — review separately) |
| `riivo_WhatsApp_Template_WithButton` | `ttt_invoice_reminder_paylink_v2` — also the D12 touch-5+ fallback, read by #99 |
| `riivo_WhatsApp_Template_NoButton` | `ttt_invoice_reminder` |
| `riivo_ReminderTestMode` | `true` |
| `riivo_BadDebtMinDaysBetweenTouches` | `2` — created for #98 |
| `riivo_BadDebtVolumeChangeThresholdPercent` | **not created yet** — #101's only knob, default 40. `ensure_env_var` in the deploy script creates it |
| `riivo_varFlowErrorTeamMail` | `233fd44c.riivo.io@za.teams.ms` — the alert child's recipient, i.e. where a parked run lands |
| `riivo_EnvironmentAddress` | *value* `https://tttdevelopment.crm4.dynamics.com/` — passed to the alert child so the email names the environment |
| `riivo_BadDebtCanaryContactIds` | **not created yet** — #102's restriction list, default empty. `ensure_env_var` creates it |
| `riivo_BadDebtEnabled` | **not created yet** — #104's kill switch, default `yes`. `ensure_env_var` creates it. `no` stops the campaign, between runs *and* part-way through one |
| `riivo_SendEmail` | **`no`** — org-wide. The email child creates every mail as a *draft* and sends nothing while this is off. Read by 71 flows |
| `riivo_SharedSenderUserId` | `23bfea8c-e77f-ef11-ac20-7c1e5220cbf3` = `riivo Developer`, `riivo-dev@ttt-tax.co.za`. Handed to the email child as `senderUserId` |
| `riivo_ServiceQueue` | `1a83f63c-…` = **TTT Notifications**, `tttnotificationsdev@ttt-tax.co.za` — the actual **From** on a bad-debt email, because the child is called with `variant: System` |

> **The table above lists *effective* values.** Reading `defaultvalue` alone
> misreports this environment: `riivo_PaymentLink_BaseUrl` defaults to
> `payment-link-ttt.azurewebsites.net` but its **value** is
> `https://ttt-payment-link-huhhgzewb4hkdqdt.southafricanorth-01.azurewebsites.net`,
> and the function key differs from its default too. `--check` now prints the
> effective value of the three switches that decide what a run does.

---

## Policy decisions settled in #97 — build to these

- **D10 — chase the NEWEST open invoice.** The age band therefore derives from
  the newest invoice. This **contradicts `CONTEXT.md` § Campaign key**, which
  defines the band against the client's *oldest* In-scope invoice. The
  contradiction is accepted and recorded, not an oversight — do not "fix" it.
- **D11 — stop rule stays Paid-only.** No promise-to-pay brake. Departs from
  stories 22–23 of `docs/spec-bad-debt-statements.md`; the Statement build owns
  that. Channel consent flags are still enforced unconditionally.
- **D12 — from touch 5, fall back to one general template and keep sending.**
  Use `riivo_WhatsApp_Template_WithButton` (`ttt_invoice_reminder_paylink_v2`),
  already approved with a Pay-now button. **No Meta submissions needed.** Never
  wrap back to touch 1 — a fresh "opening" message after a final notice is the
  failure mode this guards against.

---

## The artifact, and how to extend it

The flow definition is **authored as tested code**, not clicked together:

| File | What it is |
|---|---|
| `flows/badDebtRecoveryTouches.ts` | Builds the definition. Edit here, never in the designer. |
| `flows/badDebtRunTable.ts` | Declares the `riivo_baddebtrun` table (#101) and renders its metadata POSTs. The flow imports its names from here, so the two cannot drift. |
| `flows/__tests__/badDebtRecoveryTouches.test.ts` | 184 tests pinning the expensive-to-get-wrong properties. |
| `flows/deploy-bad-debt-touches.sh` | Idempotent deploy. `--check` reads only; `--replace` re-deploys a changed definition. Also creates the two environment variables this build owns and the run table, column by column. |

`--check` compares the rendered definition against the `clientdata` in
Dataverse byte-for-byte, so "the tested artifact is the deployed artifact" is a
command, not a claim.

**Updating a deployed flow is a REPLACE.** `clientdata` cannot be PATCHed, so
`--replace` POSTs the new definition, verifies the stored bytes match, and only
then DELETEs the old row — which mints a **new `workflowid`**, so update any
reference to the guid afterwards. It refuses to replace a flow that is switched
on, and refuses to act at all if two flows share the name.

```
npx vitest run flows/                              # 184 tests
npx eslint flows/ && npx tsc --noEmit              # both clean for flows/
bash flows/deploy-bad-debt-touches.sh --check      # read-only state report
bash flows/deploy-bad-debt-touches.sh --replace    # re-deploy after an edit
```

### Facts the tests encode — do not re-derive them by guessing

- **Consent polarity is inverted between channels.**
  `riivo_whatsappoptinout` **true = opted IN**; `donotemail` /
  `donotbulkemail` **true = suppressed**. Both default to contactable when
  null. Read off the live cadence flow `c430ace5`, not inferred from the column
  names. Getting this backwards messages exactly the people who opted out.
- **Chaseable statuscodes are `958140000` (Open) and `463630001` (Partially
  Paid)** — and Partially Paid is absent from every pre-2026-09 document.
  Filtering on `statecode eq 0` alone sweeps in `463630002` Payment Received –
  Pending Settlement, i.e. clients whose money is already in flight.
- **Amounts come from `ttt_outstanding`**, never an original invoice total.
- **The recurrence is Mon/Thu 09:45 SAST, not the 09:30 the issue asked for.**
  `dd5a766f` runs daily at 09:30 and *creates* `riivo_baddebt` rows; reading
  that table on the same tick is a race.
- **Population is `riivo_baddebt` rows directly**, not invoices flagged
  `riivo_referredtobaddebts`. The invoice-side query in `dd5a766f` is fenced by
  a go-live `createdon` floor that would silently exclude the legacy bad debt
  making up most of the book.
- **WDL has no `sort()`.** "Newest" is resolved by `max()` over `ticks()`.
- **Action names must be unique across the WHOLE definition**, not per scope,
  and scopes nest at most 8 deep. The module renders **90 actions at depth 7**.
  `runAfter` is scoped, though: it may only name siblings in the same scope. A
  test now pins both — plus that no scope's ordering is circular, which is a
  definition Dataverse accepts and the Flow service rejects. The module now
  renders **105 actions**, still at a maximum depth of 7.
- **`ttt_customer` on `new_invoices` is polymorphic** (account *or* contact),
  so `_ttt_customer_value eq {guid}` is the right filter either way.
  `riivo_baddebt.riivo_client` is contact-only.

---

## What #99 added, and the seam it left

The campaign key resolves in `Apply_to_each_|_Selected`: relationship from a
top-1 "has this client ever paid" query, age band recomputed from the chased
invoice's `createdon`, touch number from `riivo_campaignsendcount + 1`, and the
name assembled as `bad_debt_wa_{band}_{relationship}_day{N}` — then **checked
against the 24 approved names** before it counts as sendable. Past touch 4, D12
hands over to `riivo_WhatsApp_Template_WithButton`; it never wraps to touch 1.

**The seam #102/#103 replace is `Compose_|_Send_Outcome`.** Bookkeeping records
a touch that *happened*, so the write is gated on a send outcome rather than on
test mode. This slice sends nothing, so both outcomes are literally `false` and
no counter can move — flipping `riivo_ReminderTestMode` off early is safe.
Replace that compose with the real channel results and the gate starts working
as intended; the test named "cannot advance a counter" is the one that will
fail and must be updated when you do.

**Holds are the other thing to know.** A client whose chased invoice is younger
than 30 days or older than three years has **no** age band and is held, not
banded into the nearest neighbour — guessing would put a prescribed debt into
the 1–3y final-notice copy. #98's selection query enforces neither bound, so the
hold is where it is caught. Held rows appear in the dry-run report with a
reason.

The tests **evaluate** the deployed WDL rather than string-matching it (there is
a small expression reader in the test file), and the 24 approved names are
cross-checked against `convex/seedWhatsappTemplates.ts`, which mirrors what is
approved in Meta.

### Still needed for #99

1. `bash flows/deploy-bad-debt-touches.sh --replace` — a Dataverse write, which
   the agent permission classifier blocks; Luc ran the #98 deploy for the same
   reason. Note the new `workflowid` it prints.
2. A human test-mode run, reading `Compose_|_Dry_Run_Report`: every touch row
   carries `ageBand`, `relationship`, `touch` and `templateName`; every held row
   carries a `reason`. In dev today that is 5 clients, all `90d_1y`, two of them
   on touch 2 (`riivo_campaignsendcount = 1`), so the Day-0 and Day-10 paths are
   both exercisable without touching data.

## What #100 added: the inputs, and the abort

Everything lives in `Scope_|_Prepare_Documents`, inside the same
`Apply_to_each_|_Selected` loop. A client leaves it with both a payment token
and a rendered PDF, or leaves it held.

- **Mint** is idempotent by *skipping*: an invoice arriving with a
  `riivo_paymenttoken` never reaches the endpoint, so a re-run costs nothing and
  cannot replace a token a client already holds a link to.
- **The token is written back**, which the cadence flow `c430ace5` does *not*
  do — it mints inline and drops the result, so it re-mints every run. The
  patch is lifted from `9f8601a5` instead, which already owns that column.
  `riivo_paymentlinksenton` is stamped monotonically: a date already told to a
  client is never moved.
- **The PDF comes from `Invoice - Child - Generate PDF`** (`be610dd6`), which
  owns the line-item payload and the `riivo_InvoiceGen2_Endpoint` call, and
  handles Tax *and* Accounting invoices — the dev book is 53 Tax to 7
  Accounting, so a Tax-only path would silently hold every accounting debtor.
- **The abort is a handled scope failure.** `Filter_|_Prepare_Failures` runs
  after the scope on *any* status, so one unrenderable invoice cannot end the
  run for the clients behind it in a sequential loop. An aborted client gets no
  bookkeeping patch at all, which is what makes "the next run picks them up
  again" true rather than hopeful.
- **Two swappable points, read from nowhere else**: `Compose_|_Document` (the
  Statement Issue GUID swap lands here) and `Compose_|_Payment_Link`, which
  publishes both the full URL and the **bare token** the Meta button needs.

### The 429 finding

Azure documents the retry policy as covering 408/429/5xx but says nothing —
error handling, limits, or the dedicated 429 page — about honouring
`Retry-After`. The default policy would retry on its own clock. So the mint call
carries `retryPolicy: none` and sits inside an `Until` that reads the header and
waits exactly that long. The PDF call keeps its default policy deliberately:
the child's *own* HTTP action already retries the generator, which is the layer
where a `Retry-After` header actually arrives — a child flow's `Response` cannot
carry one back to us.

### Still needed for #100

Nothing separate: it rides #99's replace-deploy. Two additions to the checks —

1. `--check` now verifies the three payment-link environment variables and that
   the PDF child flow exists and is **on**. All four confirmed present in dev on
   2026-09-11. A missing one is a runtime failure for every client, not a deploy
   error, so the script aborts a deploy rather than shipping it.
2. On the test-mode run, every touch row must carry a non-empty `paymentLink`
   and `documentBytes > 0`. The two payment-link parameters are declared with
   **empty defaults** so no function key reaches git — which makes that run the
   proof the environment-variable bindings actually resolve. A blank
   `paymentLink` means the binding failed, not the endpoint.

## What #101 added: the run-level brake

Between selection and the per-client loop. A run that does not look like the
last one parks itself, having produced nothing.

- **It gates the loop, not the send.** The loop mints tokens, writes them back
  and renders PDFs in *both* modes, so a gate in front of the send would still
  let an anomalous run make hundreds of function calls. `Terminate` ends the run
  where it stands, so nothing had to be re-nested to achieve this.
- **An aborted run is never a baseline.** The previous count comes from the most
  recent run whose `riivo_outcome` is `proceeded` **or** `accepted`. Without
  that the tripwire disarms itself after one park. A population that stays
  anomalous therefore keeps parking, which is the point; `accepted` is the way
  out, and deliberately a one-field edit on the parked row rather than a
  threshold change, because a loosened threshold is the temporary fix that
  becomes permanent.
- **Rehearsals count as baselines.** Selection does not read
  `riivo_ReminderTestMode` — only the bookkeeping gate does — so a dry run
  selects exactly what a live run would. `riivo_testmode` on the row is how a
  human tells them apart afterwards. This is also what makes the tripwire
  exercisable in dev without sending anything.
- **The alert is the house child** (`6b0bff17`), not an `email` row of our own.
  It owns the recipient, the sender and the run link; its `text`/`text_1` inputs
  are free text, which is how the two counts and the threshold reach the reader
  and how the reason reaches the subject. This keeps the suite's strongest
  assertion intact: **this flow still creates no `email` row and performs no
  `SendEmail`**. The park terminates as **Failed** so it is red in run history,
  and the `Terminate` runs after the alert on *any* status — an undeliverable
  email must not keep a parked run alive.
- **Two accepted holes**, both in the code as comments: growth from a zero
  baseline is unguarded (there is no proportion of zero, and parking every
  restart is worse), and the percentage is integer-truncated, so the comparison
  is coarse by a fraction of a percent in the direction of proceeding.

### Still needed for #101

1. `bash flows/deploy-bad-debt-touches.sh --replace`. In deploy mode it also
   creates `riivo_BadDebtVolumeChangeThresholdPercent` and the
   `riivo_baddebtrun` table (10 columns, from `flows/badDebtRunTable.ts`, into
   the `2Tables` solution). Both are Dataverse writes, which the agent
   permission classifier blocks — and the table metadata POST is the one piece
   of this that has never been executed, so if it errors, paste the body back.
   `--check` confirmed on 2026-09-11 that everything else it depends on exists.
2. The first run writes the first row and **must proceed**: no baseline must
   never mean deadlock. Expect `outcome=proceeded`, `previouscount=0`,
   `tripwireVerdict=proceed` in the report.
3. To see it park, take a second run after editing the first row's
   `riivo_selectedcount` far from the live count (or drop the threshold to 1).
   Expect: nothing minted, a "Flow Failure" email carrying both counts and the
   threshold, a row with `outcome=aborted`, and no change to any
   `riivo_campaign*` field. Then set that row to `accepted` and the next run
   proceeds — which is the AC about re-running after review.

## What #102 added: the email channel, and the canary

### The send

One call to `Email - Child - Build Branded HTML Email, Create or Send`
(`0d0bc4d6`), copied from the cadence flow `c430ace5`, which already calls it
with an invoice PDF and a Pay-now button.

**The issue's stated main risk is closed.** Reading the child's deployed
definition on 2026-09-11: it takes `buttonUrl`/`buttonLabel` **and**
`attachmentsJson` in one call, and its internal order is `Create_Branded_Email`
→ regarding → `Apply_to_each_Attachment` → `Condition_|_Send` → response. The
attachment is written **before** the send, so it is on the message the client
receives. No reuse workaround was needed.

What the child owns, and this flow therefore does not: the branded HTML, the
signature, the unsubscribe footer, the `email` row, the
`activitymimeattachment`, and the bound `SendEmail`. **The Outlook connector
appears nowhere in the path** — a test asserts that on the whole definition.
The test suite still asserts that this flow creates no `email` row and performs
no `SendEmail` *of its own*, which is a stronger statement now than it was
before the channel existed.

Things settled while wiring it up:

- **`variant: System`.** From is the service queue (`TTT Notifications`,
  `tttnotificationsdev@ttt-tax.co.za`), not a consultant. This also switches
  the child's CC-the-owner behaviour **off** entirely — `Compose_|_Cc_Enabled`
  requires `variant: Consultant` — which is what we want: nobody is CC'd on a
  few hundred dunning emails twice a week.
- **`senderUserId` is required anyway.** The child validates it non-empty and
  then reads that systemuser, even though System variant does not send as
  them. It is fed `riivo_SharedSenderUserId`, which already exists for exactly
  this "fallback From" purpose. `c430ace5` passes the invoice owner instead and
  drags in a whole team-owner resolution subtree to answer a question System
  variant never asks.
- **`category: Transactional`.** A demand for payment on a named invoice. The
  child's own extra suppression (`icon_sendemailclientnotifications`,
  `donotbulkemail`) only applies to `Marketing` — but our selection already
  applies `donotemail` **and** `donotbulkemail`, so nothing is lost.
- **Consent is checked twice**, and the second check is the child's: it
  re-reads the contact at send time and refuses on `donotemail` or a recorded
  bounced address, reporting `skipped` + `skipReason` rather than failing.
- **Payloads are serialised, not concatenated.** `attachmentsJson` and
  `paragraphsJson` are built with `string(createArray(...))` over a composed
  object. `c430ace5` builds its attachment JSON by string concatenation, so a
  quote or a backslash in a generated filename would hand the child a body it
  cannot parse. A test asserts no hand-built JSON fragment survives.
- **Copy is keyed on the touch only** — five rungs, Day 0/10/25/40 then D12 —
  not on the age band or relationship. Meta forces 24 WhatsApp templates
  because it approves each variant; email has no such constraint, and thirty
  hand-written paragraphs to keep in step buys a distinction the reader of a
  single message cannot perceive. The final-notice and closing paragraphs are
  taken verbatim from `c430ace5`, which is already in front of clients.
- **Test mode sends nothing at all** and creates no `email` row — a deliberate
  departure from `c430ace5`, which redirects to `riivo_TestRecipient`. Its
  population is a handful of invoices; ours is the whole book, and a redirected
  rehearsal would mail one address several hundred times. Seeing a *rendered*
  message is what the canary is for.
- **Bookkeeping advances only on the child's own `sent`.** A suppressed
  recipient, a skipped send and a draft left by `riivo_SendEmail` all read
  false and move no counter, so those clients are simply selected again next
  run.
- **A failed send is contained**, the same way a failed preparation is:
  `Compose_|_Email_Result` runs after the send condition on *any* status, so
  one client's failure cannot end the run for the clients behind them.

### The canary

`riivo_BadDebtCanaryContactIds` — a JSON array of contact ids. While it is
non-empty the run speaks only to those clients. It exists because without it
there is no way to do what the issue asks: rehearse on colleagues, then canary
on a few real clients.

- It **narrows the selection query**, following the same principle as the
  cadence guard: an unlisted client is never fetched, so no token is minted and
  no PDF rendered for them either.
- A malformed value **fails the run** during selection. Treating an
  unparseable allowlist as "no restriction" would turn a typo into a mass send.
- A canary run **skips the volume tripwire** — three of six hundred is a 99%
  fall, so the tripwire could only ever park it — and is recorded as outcome
  **`canary`**, which is **not a baseline**. The mirror of the aborted-run
  rule, from the other side: let a canary set the baseline and the *next
  unrestricted run* looks like a twentyfold explosion and parks. The tripwire
  would fire on the return to normal rather than on the anomaly.
- Every canary run **emails the team**. The failure mode of an allowlist is not
  that it is set — that is deliberate — it is that it is **left** set, which
  turns a campaign into a private conversation with three people and shows up
  nowhere anybody looks. Twice a week is exactly as annoying as it should be.
  Wart: the house alert child hardcodes `Flow Failure:` into its subject, so
  the notice says "not a failure" in the text — the honest fix available
  without editing a child 218 flows depend on.

### AC 6 as written is self-defeating here, and was not followed

> *"The rehearsal is run against the three colleague invoices with `donotemail`
> and `donotphone` set on those contacts to suppress the live dunning
> orchestrator."*

That pattern comes from `bad-debt-merge-csv-handoff.md`, where the sender was
the Convex comms tool, which does **not** read `donotemail` — so the flags
suppressed the *Dataverse* orchestrator while the campaign mailed anyway. This
flow is a Dataverse flow that honours `donotemail`, twice over: our selection
gate and the child's own re-check. **Setting `donotemail` on the colleague
contacts would suppress the rehearsal itself**, and AC 6 would then contradict
AC 9.

What replaces it: the canary list is what keeps the run to three people, so no
suppression flags are needed to protect anyone else, and `donotemail` must stay
**false** on the three contacts. `donotphone` / the WhatsApp opt-out can still
be set to keep the other dunning orchestrator quiet, and reverted after.

**In dev this is easier than the issue assumes.** Today's selection is five
clients, all test contacts, and three of them already mail addresses we own:

| Contact | id | Email | Touch | Amount |
|---|---|---|---|---|
| Michael Test Contact | `26372e5b-40db-f011-8543-7ced8d7556e1` | michael@riivo.io | 1 | R200.00 |
| Sheri Parasaraman | `50334bea-1a00-f111-8406-000d3ad7d88c` | luc@riivo.io | 2 | R10 000.00 |
| test riivo | `40d03cad-6cf7-f011-8406-000d3add243f` | luc@riivo.io | 2 | R5 750.00 |

That set exercises the touch-1 **and** touch-2 copy, needs no production data
and no flag edits. The other two selected clients are `New TestSharePoint` (no
email address — a good negative case) and `Test Referral`
(`test@mailnewo.co.za`).

### The org-wide switch nobody mentioned: `riivo_SendEmail`

Its **value in dev is `no`**. The email child reads it and, when it is off,
saves every mail as a **draft** instead of sending — for all 71 flows that
read it. So:

- The first canary run with it **off** produces inspectable drafts: real
  branded HTML, real attachment, real button, on the invoice's timeline, sent
  to nobody. That is the cheapest possible way to satisfy "the rendered message
  is inspected by a human before any client is sent to", and it is a better
  rehearsal than a redirected test-mode send.
- Turning it **on** arms every other flow that reads it. 16 of the callers of
  the email child are on, and they are event-triggered — so any record edited
  in dev during that window can mail a real contact. **Turn it on, run, turn it
  off.**
- The run says which happened: `emailSendingEnabled` in the report, and each
  touch row carries `emailNote` = "the email was created but not sent, because
  riivo_SendEmail is off in this environment".

### Still needed for #102

1. `bash flows/deploy-bad-debt-touches.sh --replace` — the same one command
   that carries dev from #99 to #102. It also creates
   `riivo_BadDebtCanaryContactIds` and the run table, which now has **12**
   columns (`riivo_canarycount` and `riivo_emailsentcount` joined it).
2. The four human steps the script prints at the end: draft rehearsal → live
   colleague rehearsal → canary on real clients → **clear the canary list**.

---

## What #103 added: the WhatsApp channel

The channel the 24 approved templates were written for, and the one the
campaign key has been resolving a name for since #99. The send is lifted from
`c430ace5` as the issue asks: upload the invoice PDF to Meta's media endpoint,
take the media id as the template's document header, build body and button
components, POST the template, log the result.

### Read before you switch it on: there is no draft mode

`riivo_SendEmail` gave the email channel a free rehearsal — a real branded
message, real attachment, real button, sent to nobody. **WhatsApp has no
equivalent.** There is one TTT WhatsApp Business number, Meta offers no sandbox
of it, and dev's `riivo_varMetaURI` names the **same phone number id as prod's**
(`1126852847178432`). So a dev run that is not in test mode sends a real
message from the live business number to a real handset.

Test mode and `riivo_BadDebtCanaryContactIds` are the entire safety envelope.
That is not a gap in the build — it is the shape of the platform — but it
inverts the rehearsal: for email the canary list was a convenience, and here it
is the only thing between a run and the whole book.

### Three things read off the deployed org that changed the build

Each would have failed silently. None produces an error anyone sees without a
handset in their hand.

**1. The D12 fallback template takes a different body.** The 24 campaign
templates are `Hi {{1}}, … Amount due: {{2}}` — name and amount. The D12
fallback `ttt_invoice_reminder_paylink_v2` is `Hi {{1}}, … invoice *{{2}}* …
balance of *{{3}}*` and takes the invoice number in the middle. #99 chose that
fallback for a good reason (already approved, no Meta submission blocks the
cadence) and could not have known it was a different shape. Sending two
parameters to a three-parameter template is a 400 from Meta, so **the first
client ever to reach touch 5 would have gone silent**, months after the code
that caused it shipped. `Compose_|_Wa_Body` now switches on the same touch
boundary `Compose_|_Template_Name` does, and a test asserts the two boundaries
are the same number.

**2. `@{base64ToBinary(x)}` uploads the base64 text of a PDF, and Meta accepts
it.** The braces interpolate the decoded bytes back into a string. The upload
succeeds, a media id comes back, the template sends — and the client receives a
document that will not open. `[TEST] WhatsApp Invoice - Buggy vs Fixed PDF
Upload` (`d94a477f`, on) is still deployed in dev as the record of someone
finding that the hard way; `c430ace5` carries the fixed form. This build uses
`@base64ToBinary(…)` with no braces, and a test pins it, because nothing else
would notice.

**3. The Pay-now button prefix is baked into the template, and dev's is
wrong.** Meta stores the approved URL prefix and rebuilds prefix + suffix, so
the send passes the **bare token** — the issue's "single most likely thing to
get wrong", and the reason #100 published `token` and `url` from one compose.
But the prefix is fixed per template while `riivo_PaymentLink_BaseUrl` is
per-environment, and they disagree:

| Template | Button prefix |
|---|---|
| the 24 `bad_debt_wa_*` | `https://payment-link-ttt.azurewebsites.net/p/` |
| D12 `ttt_invoice_reminder_paylink_v2` | `https://ttt-payment-link-huhhgzewb4hkdqdt.southafricanorth-01…/p/` |

Dev's `riivo_PaymentLink_BaseUrl` is the second one. Verified by loading a real
dev token against both: the dev host answers 200, the approved host answers
`Payment link not found`. **So in dev a campaign-key WhatsApp button cannot open
its invoice, however correct this flow is** — and in prod the D12 button will
not, for the mirror-image reason. No code change fixes it: either the templates
are re-approved against one host, or both environments point at one
payment-link app. `--check` now prints both and says so. AC 4 is therefore
verifiable in dev only by reading the token out of the run report and loading
`{riivo_PaymentLink_BaseUrl}/p/{token}` by hand; the button *itself* can only be
proved in an environment where the two agree.

### The rest of it

- **Parameters are sanitised and then checked.** Meta refuses a parameter
  carrying a newline, a tab or four consecutive spaces — with a 400, not a
  visibly broken message. Newline, carriage return and tab are replaced by
  code point (`decodeUriComponent('%0A')`) rather than as literals, because a
  control character nobody can see in a diff is the wrong thing to depend on.
  Four spaces collapse **three times**: `replace` is single-pass, so one pass
  turns 16 spaces into 4, still illegal. Then `Compose_|_Wa_Params_Clean`
  asserts the result and holds the client if it is somehow still dirty — the
  issue's own instruction to assert rather than assume.
- **The filename is sanitised too.** It travels inside a `Content-Disposition`
  header, where a quote or a backslash ends the field early — the multipart
  equivalent of the hand-built JSON #102 refused to write, on a filename this
  flow does not generate.
- **Trimming is not cosmetic here.** Invoice numbers in this org carry trailing
  spaces (`"luc duval - WATEST83695332 "`), and the D12 template interpolates
  one.
- **All 24 campaign templates are APPROVED in Meta**, in `en`, read off the
  WABA on 2026-09-11 — worth knowing because our own `whatsappTemplates` table
  still says 12 of them are `pending`. The app's status column is display-only
  and gates nothing, so this is stale local data rather than a blocker;
  `npx convex run actions/whatsappTemplateAdmin:reconcileMetaStatuses` would
  realign it.
- **Every attempt is logged, sent or refused.** One `riivo_whatsappcommunications`
  row per attempt, status `sent` (463630001) or `failed` (463630003), with
  Meta's own words in `riivo_failurereason` (truncated to 900 of the column's
  1000 characters). Both reference flows log only successes; this campaign's
  rule is that a silent client is never a silent failure, and the run report
  expires with the run history while the row stays on the client's timeline.
- **The bot is told what went out.** `WhatsApp - Child - Sign and Post Outbound
  Template Send to Bot Webhook` (`5d353829`), called by both reference flows,
  HMAC-signs the send and posts it to the conversational bot so an inbound
  reply is threaded to the message that prompted it. That matters here more
  than anywhere: every approved template ends by inviting a reply. It is called
  last, only on a real send, and can never fail the touch.
- **Both Meta calls sit in the same `Until` the mint call does**, retried only
  while the endpoint answers 429 and waiting exactly as long as `Retry-After`
  asks, with the platform's own retry policy switched off. Loop concurrency was
  already capped at 1 (R8).
- **Bookkeeping stays an OR.** A client reached on either channel has had their
  touch. Counting it twice would spend two rungs of a five-rung ladder in one
  day. A 429 retried to exhaustion, a refused template and a rejected parameter
  all read false and advance no counter, so those clients are simply selected
  again next run.
- **Counts are kept side by side, never summed.** `riivo_whatsappsentcount`
  joins `riivo_emailsentcount` on the run row (13 columns now) and
  `whatsAppsSent` joins `emailsSent` in the report: a run where WhatsApp
  collapsed while email held up is invisible in a single total.

### One asymmetry, deliberately left

The email child re-reads the contact at send time and refuses on `donotemail`,
so email gets a second consent check against fresher data for free. **WhatsApp
does not.** Consent is read once, in the selection loop, and the send loop
trusts it. Closing the gap means one extra `GetItem` per eligible client per
run; the exposure it would close is one message to somebody who opted out
*during* the run, and they are excluded from the next one anyway. Beyond what
the issue asks, so not built — but it is a real difference between the two
channels and should be a deliberate choice rather than a discovery.

### Still needed for #103

1. `bash flows/deploy-bad-debt-touches.sh --replace` — the same one command,
   now carrying dev from #99 all the way to #103. The run table gains
   `riivo_whatsappsentcount` (13 columns); the three Meta variables already
   exist and are only checked for.
2. The human steps the script prints as 11–15: colleague rehearsal on real
   handsets → check the bookkeeping and the log rows → prove an opt-out is
   honoured → canary on real clients → **clear the canary list**.

---

## What #104 added: the parts of "unattended" that are not the flow

From here the schedule does the sending, so the subject changes. Every slice
before this one was about what the run says to a client; this one is about what
a human can do about it afterwards. Two questions, both of which had bad answers
before: **how do I stop this**, and **how do I tell whether that run was
normal**.

### The kill switch

`riivo_BadDebtEnabled`, `yes`/`no`, matching `riivo_SendEmail` — the org's
existing example of exactly this kind of switch. `no` stops the campaign;
anything else, including blank, means running.

An environment variable rather than the flow's own state, because **the answers
that already existed were all owned by somebody else**: deactivating the flow
and cancelling a run are both connection-gated to riivo Admin in this org, and
the person watching the wrong message go out at 09:47 on a Monday is not
necessarily them. An environment variable needs no portal rights over the flow
and no deploy.

It is checked **twice, in two different ways, for two different questions**:

- **Should this run start?** Read from the flow parameter, which the platform
  binds fresh at run start, so the cheapest read is also the correct one. A
  disabled run terminates before selecting anybody: no query, no mint, no
  render, and **no `riivo_baddebtrun` row**, which keeps it out of the
  tripwire's baseline for free.
- **Should this run continue?** The parameter cannot answer that — Power
  Automate binds it once, so to a run already in flight the switch is frozen at
  whatever it said at 09:45. So the loop re-reads the live value from
  Dataverse, once per client. That costs one extra List per client, which is
  deliberate and is the honest price: it is the difference between a wrong
  message reaching twelve clients and reaching six hundred. `riivo_durationseconds`
  exists partly so that price can be judged against a real number.

**Three platform facts were checked against the org rather than assumed**, by
reading all 322 deployed flow definitions:

1. **`Terminate` is not legal inside a loop.** 487 Terminate actions across the
   org, **not one** inside a Foreach or Until. So the mid-run stop is *not* a
   terminate — it rides the `Condition_|_Template_Approved` gate that was
   already there, and a switched-off run **holds** every client it has not
   reached, with a reason. That costs the remaining clients three reads each
   and no mint, no PDF, no email and no WhatsApp. It is also better than the
   terminate would have been: the run finishes, so the report says exactly who
   was reached before the switch was thrown and who was not.
2. **`Cancelled` is a real terminate status here** — 32 uses in deployed flows.
   The top-of-run stop uses it rather than `Failed` (a run that did what it was
   told is not an error) or `Succeeded` (a switched-off fortnight must not read
   as a column of green ticks).
3. **The live environment-variable read has one precedent in this org**, and
   the build copies it verbatim: `Invoice - Offer Report When Paid` (activated)
   reads `environmentvariablevalues` filtered on
   `EnvironmentVariableDefinitionId/schemaname`, with `runAfter: [Succeeded,
   Failed]` and a `first(coalesce(..., ...))?['value']` read that returns null
   rather than throwing on an empty result. An earlier draft of this slice
   invented a two-call definition-lookup to avoid guessing that navigation
   property's spelling; the org already knew it.

**The live read fails OPEN**, and this is the one place in this build where
that is the right direction. It is an *addition* to the switch, not the switch:
the parameter gate still stops the next run and the maker portal still stops the
flow, so if the system table cannot be read the honest outcome is the behaviour
the campaign had before #104, rather than a campaign that cannot run at all.
`killSwitchLiveRead` in the report is how anyone finds out — on an ordinary
Monday, rather than on the day they need it.

**Every skipped or stopped run emails the team**, through the same house child,
for the reason the canary notice does: the failure mode of this switch is not
that somebody sets it — that is the point of it — it is that nobody unsets it,
and a campaign that has quietly stopped chasing money looks exactly like one
that is running and finding nobody to chase. The mid-run notice fires **once**,
after the loop, found by filtering the held rows on the reason string rather
than by a flag set inside the loop; per-client it would have mailed the team for
every remaining name on the list.

### The numbers a run leaves behind

Three columns, sixteen now on `riivo_baddebtrun`:

- **`riivo_startedon`** — written with the *first* patch, so a run that died in
  the loop still says when it began.
- **`riivo_durationseconds`** — AC 5. Run history answers this too, until it
  expires; the column is what makes "is this getting slower" a question about a
  table rather than about memory.
- **`riivo_throttlewaits`** — counted as each `Retry-After` wait happens, across
  the mint call and both Meta calls. **Once an `Until` has retried a 429 into a
  200 the wait is invisible**: run history shows a succeeded action and nothing
  else. Read beside the duration, it separates "the endpoints asked us to slow
  down" from "something else got slower".

All three, plus `killSwitch`, `killSwitchLiveRead` and `stoppedMidRun`, are in
the run report as well.

### `docs/runbook-bad-debt-recovery.md`

AC 7 and AC 8. Written for whoever is looking at a run that does not look right,
not for whoever is building the next slice: how to stop it and who can, what a
healthy run's numbers look like, the five places a failure surfaces, and a
symptom-to-cause list for the failure modes this build already knows about —
including the ones that are *expected* in dev (the Pay-now prefix mismatch,
`riivo_SendEmail` off) so they are not diagnosed from scratch at 09:50.

### Still needed for #104

1. ~~The replace-deploy~~ — **done 2026-09-14.** See the deployed state at the
   top of this file.
2. The human steps the script prints, **all twenty of them**, because nothing
   has been run yet: the connection reference, the test-mode run, the tripwire
   exercise, the email draft rehearsal and live rehearsal, the WhatsApp
   colleague rehearsal, the opt-out proof, then #104's own — prove the kill
   switch **while the canary list still names only colleagues** (14) → check
   `killSwitchLiveRead` is true (15) → canary and clear the list (16, 17) →
   recurrence on, two cycles (18) → review the threshold against the two real
   counts (19) → hand to Luc for prod (20).

---

## What the deploy itself taught us

The `--replace` took three attempts, and **neither failure was in the flow**.
Both were in the deploy script, and both are worth knowing because the same
shapes will recur.

**1. The column-creation branch had never once executed.** It threw
`Cannot read properties of undefined (reading 'split')` after the table POST
had already succeeded, leaving the table created with only its primary name
column. The cause: `tsx -e` leaves `process.argv` as `[node, firstArg]` — there
is no script path in slot 1 — so the argv index that looks right is off by one.

The interesting part is not the off-by-one, it is **why nothing caught it**.
Every earlier run found the table missing and skipped the whole block, and
`--check` prints "would create" without generating a single body. So the one
path that had to work on the day the table first existed was also the only one
nothing had exercised. The handoff had flagged the table POST as unproven and
was right about the neighbourhood, wrong about the line. The list now travels
through the **environment** rather than argv, and an empty column set stops
rather than proceeding.

**2. A Dataverse blip aborted the deploy with a Python traceback.** On the next
attempt the dependency check for `riivo_PaymentLink_FunctionKey` came back with
an empty body; asked again a minute later it — and all its neighbours — answer
200 with valid JSON. Every read in the script piped raw curl output straight
into `python3` without looking at the status code, so *any* transient response
became an unreadable traceback and left the deploy half-finished wherever it
landed.

`api_json` now sits between the two: it checks the status, retries throttling,
5xx, dropped connections and 2xx-but-unparseable four times with linear backoff,
and otherwise fails with the method, the path, the status and Dataverse's own
words. Two lookups where "not there" is a real answer — the run table on a
first deploy, a child flow that has gone missing — take a `missing_ok` flag that
turns a 404 into `{}`; that replaced two `2>/dev/null || echo …` fallbacks which
had been swallowing every *other* error too.

**The lesson for the next deploy script in this repo:** a branch that only runs
once, on first creation, is a branch nothing has tested — and a `--check` mode
that reports intent without building the payload does not test it either. If a
code path's first execution is also its most consequential, exercise it against
a scratch object first.

### What #104 asks for that is not built, and cannot be

Six of its eleven ACs are observations of two real runs, and an agent can
neither activate the flow nor run it. The threshold review (AC 6) needs two
real counts that do not exist yet. The prod handover (AC 11) is Luc's by
decision, and AC 10 is #96, whose prod half is still unanswered — **that one
blocks promotion, not this build**.

---

## First runs in dev, 2026-09-14

Two runs, both in test mode, both verified against the org rather than read off
the report.

**Run 1 - proceeded.** 14 candidates collapsed to 5 clients, all `90d_1y`,
three on touch 1 and two on touch 2, so both template paths were exercised.
Every touch carried a payment link and an ~89KB PDF; nothing held. No counter
moved, no `email` row, no `riivo_whatsappcommunications` row.
`killSwitchLiveRead` came back **true**, so #104's per-client kill switch
resolves in this environment.

**Run 2 - parked, on purpose.** With run 1's `riivo_selectedcount` moved to 50,
the next run compared 5 against 50 and tripped the 40% threshold. The useful
part is what it left behind: `riivo_outcome=aborted`, `riivo_abortreason`
carrying the same sentence as the alert, and **every after-the-loop field
null** - resolved, held, both sent counts, and #104's own
`riivo_durationseconds` and `riivo_throttlewaits`. That is the design observed
rather than asserted. A token cleared beforehand stayed null, so the park really
did happen upstream of everything that costs something.

**The house alert child ignores `riivo_SendEmail`.** The park notice was status
**Sent**, with `senton` stamped, in an environment where `riivo_SendEmail` is
`no` and every other flow's mail is a draft. So the org-wide switch does not
silence safety alerts - the fail-safe direction, and the reason a parked run
reaches anybody in dev at all. Consistent with #106: that child sends in both
branches of its own on/off condition.

### Two findings against #104's own acceptance criteria

- **Duration.** 95 seconds for 5 clients, with no sending and no minting - about
  19s per client. At a real book of ~600 that extrapolates past three hours,
  before the per-client Meta upload and template POST are added. AC 5 asks
  whether the run finishes in a sensible window; on this evidence it needs
  measuring again at canary scale before the recurrence is trusted. Part of that
  cost is #104's own per-client kill-switch read, accepted precisely so it could
  be judged against a real number.
- **The mint path has still never run.** All five invoices already carried a
  `riivo_paymenttoken`, so the mint call was skipped for every one of them -
  correctly, it is idempotent by skipping. `riivo_PaymentLink_FunctionKey` and
  the endpoint therefore remain unproven; the links in the report only prove
  `riivo_PaymentLink_BaseUrl` resolves. Clearing one token and re-running is the
  only way to cover it.

---

## Open threads worth not losing

- **#96 prod half is unanswered and blocks prod promotion.** The daily
  WhatsApp/SMS dunning observed in prod since **15 July 2026** is **not
  explained by dev state** — the live dev SMS flow fires on `icon_daysactive` ∈
  `[2,4,5,6,7]`, a window that closes on day 7, while bad debt starts at day 30.
  So prod runs a different flow, a different day-set, or something not in this
  inventory. Also unanswered: prod SP privileges (R7).
- **Contact stacking is smaller than the spec feared.** On dev state, worst case
  for one debtor is **2 messages/week**, both from the new touch.
- **A live flow is messaging clients whose payment is in flight.**
  `Invoice - Scheduled - Send Overdue Payment SMS Reminders...` (`2b89f0b5`,
  **on**) filters on `statecode eq 0` with no `statuscode` clause, so it reaches
  `463630002` Pending Settlement clients. Pre-existing, unrelated to this build.
  **Now filed as #105.**
- **`riivo_SendEmail` is off in dev and is org-wide.** Not a bug, but it is
  load-bearing for #102 and is documented nowhere else: 71 flows read it, and
  with it off every one of them drafts rather than sends. Whoever owns dev
  hygiene should know that turning it on for a rehearsal arms 16 live
  event-triggered flows for the duration.
- **The house failed-flow alert child cannot be switched off.** `6b0bff17`
  branches on `riivo_varFlowErrorSendBool` and then **sends in both branches** —
  `Send_Mail` and `Do_not_Send_Mail` are identical `SendEmail` calls. Setting
  that variable to `no` suppresses nothing, org-wide, in 218 flows. For a safety
  alert that is the fail-safe direction, so #101 does not work around it.
  **Now filed as #106**, which notes the decision to take first: make the switch
  work, or remove it.
- **Three live credentials are stored as plaintext default values** on their
  environment variables: `riivo_PaymentLink_FunctionKey`,
  `riivo_varMetaAccessToken` (a live Meta bearer token for the org's single
  WhatsApp Business number) and `riivo_HmacFunctionKey`. **Now filed as #107** —
  one ticket, because the same storage decision was made three times, and it
  calls for rotation as well as a move to Key Vault.
- **The WhatsApp button prefix and `riivo_PaymentLink_BaseUrl` disagree in both
  directions** (see #103 above). The campaign templates point at
  `payment-link-ttt.azurewebsites.net`, the D12 fallback at dev's host. Neither
  is fixable in the flow, and one of the two will be wrong in whichever
  environment goes live first. **This blocks AC 4 of #103 from being proved in
  dev**, and it is the first thing to settle before prod.
- Two #98 ACs still need a human in the maker portal: the same-day re-run check
  and the dry-run diff against the comms tool's list.

---

## Working conventions

- All build happens in **dev** (D9). Luc promotes dev → prod by hand. No agent
  activates or deploys anything to prod.
- Flow naming per `~/ttt-automations-update/naming-standard.md`: three segments,
  ` - ` delimiter, Title Case.
- Custom schema uses the **`riivo`** publisher. Flows land in the
  **`6Automations`** solution, environment variables in **`4Variables`**.
- Commits are prefixed `RALPH:` and list task, decisions, files and blockers.
- Config is read from Dataverse environment variables — never hardcoded.
