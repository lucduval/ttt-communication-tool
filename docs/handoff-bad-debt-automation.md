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
| #102–#104 | **#102 is the next one.** Human-gated (live sends, recurrence). |

**What is actually deployed in dev right now is the #99 definition.** Checked
byte-for-byte on 2026-09-11: the flow in dev (`3c600c0b-c5ad-f111-aaab-002248a35b45`,
draft/off) matches the rendered `#99` module exactly, so **#100's replace-deploy
was never run**. One `--replace` therefore carries dev from #99 straight to
#101 — the mint/PDF scope and the tripwire land together, and the workflowid
changes again when it does.

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
| `Invoice - Scheduled - Send Bad Debt Recovery Touches` **(ours)** | `3c600c0b-c5ad-f111-aaab-002248a35b45` | draft / **off** — carries the **#99** definition; #100+#101 replace it and mint a NEW guid. (`7d112cdb-…`, the #98 row, is gone.) |
| `Invoice - Scheduled - Payment Reminder & Link Cadence` | `c430ace5-c57b-f111-ab0f-000d3ada6ac0` | off |
| `Invoice - Scheduled - Bad Debt Referral & Owner Digest` | `dd5a766f-d67d-f111-ab0f-002248a29481` | off |
| `Invoice - Child - Generate PDF` | `be610dd6-bf7b-f111-ab0f-000d3ada6ac0` | **on** |
| `Email - Child - Build Branded HTML Email, Create or Send` | `0d0bc4d6-7f74-f111-ab0e-000d3ada6ac0` | **on** |
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
| `riivo_EnvironmentAddress` | `https://ttt-financial-group2.crm4.dynamics.com/` (the legacy dev alias) — passed to the alert child so the email names the environment |

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
| `flows/__tests__/badDebtRecoveryTouches.test.ts` | 143 tests pinning the expensive-to-get-wrong properties. |
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
npx vitest run flows/                              # 143 tests
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
  definition Dataverse accepts and the Flow service rejects.
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

## Next issue: #102 — email live

The seam to replace is still `Compose_|_Send_Outcome`. Note the test named
"cannot advance a counter, because nothing is sent to advance it" is the one
that must fail and be updated when you do, and that the two assertions about
this flow creating no `email` row and performing no `SendEmail` are the ones
#102 deliberately breaks.

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
  `463630002` Pending Settlement clients. Pre-existing, unrelated to this build,
  **not yet filed as a bug** — asked twice, still unanswered.
- **The house failed-flow alert child cannot be switched off.** `6b0bff17`
  branches on `riivo_varFlowErrorSendBool` and then **sends in both branches** —
  `Send_Mail` and `Do_not_Send_Mail` are identical `SendEmail` calls. Setting
  that variable to `no` suppresses nothing, org-wide, in 218 flows. For a safety
  alert that is the fail-safe direction, so #101 does not work around it. Worth
  its own ticket next to the `2b89f0b5` one.
- **`riivo_PaymentLink_FunctionKey` is stored as a plaintext default value** on
  the environment variable. Flagged in the spec, not actioned.
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
