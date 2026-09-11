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
| #100 Token minting + PDF | **Ready to start — this is the next one.** Blocked-by #98 is satisfied in practice. |
| #101 Volume tripwire | Ready. |
| #102–#104 | Human-gated (live sends, recurrence). |

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
| `Invoice - Scheduled - Send Bad Debt Recovery Touches` **(ours, #98+#99)** | `7d112cdb-bcad-f111-aaab-002248a35b45` | draft / **off** — carries the #98 definition; #99 replaces it and mints a NEW guid |
| `Invoice - Scheduled - Payment Reminder & Link Cadence` | `c430ace5-c57b-f111-ab0f-000d3ada6ac0` | off |
| `Invoice - Scheduled - Bad Debt Referral & Owner Digest` | `dd5a766f-d67d-f111-ab0f-002248a29481` | off |
| `Invoice - Child - Generate PDF` | `be610dd6-bf7b-f111-ab0f-000d3ada6ac0` | **on** |
| `Email - Child - Build Branded HTML Email, Create or Send` | `0d0bc4d6-7f74-f111-ab0e-000d3ada6ac0` | **on** |
| `Invoice - Automated - Close Bad Debt When Invoice Paid` | `fa37bef7-668a-f111-ab10-002248a29481` | **on** |
| `Invoice - Scheduled - Send Overdue Payment SMS Reminders...` | `2b89f0b5-a9c7-eb11-bacc-000d3ab7951b` | **on** |

Environment variables that matter:

| Variable | Value |
|---|---|
| `riivo_PaymentLink_BaseUrl` | `https://payment-link-ttt.azurewebsites.net` |
| `riivo_PaymentLink_FunctionKey` | (secret, plaintext default value — review separately) |
| `riivo_WhatsApp_Template_WithButton` | `ttt_invoice_reminder_paylink_v2` — also the D12 touch-5+ fallback, read by #99 |
| `riivo_WhatsApp_Template_NoButton` | `ttt_invoice_reminder` |
| `riivo_ReminderTestMode` | `true` |
| `riivo_BadDebtMinDaysBetweenTouches` | `2` — created for #98 |

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

## The #98/#99 artifact, and how to extend it

The flow definition is **authored as tested code**, not clicked together:

| File | What it is |
|---|---|
| `flows/badDebtRecoveryTouches.ts` | Builds the definition. Edit here, never in the designer. |
| `flows/__tests__/badDebtRecoveryTouches.test.ts` | 81 tests pinning the expensive-to-get-wrong properties. |
| `flows/deploy-bad-debt-touches.sh` | Idempotent deploy. `--check` reads only; `--replace` re-deploys a changed definition. |

`--check` compares the rendered definition against the `clientdata` in
Dataverse byte-for-byte, so "the tested artifact is the deployed artifact" is a
command, not a claim.

**Updating a deployed flow is a REPLACE.** `clientdata` cannot be PATCHed, so
`--replace` POSTs the new definition, verifies the stored bytes match, and only
then DELETEs the old row — which mints a **new `workflowid`**, so update any
reference to the guid afterwards. It refuses to replace a flow that is switched
on, and refuses to act at all if two flows share the name.

```
npx vitest run flows/                              # 81 tests
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
  and scopes nest at most 8 deep. The module renders 46 actions at depth 6.
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

## Next issue: #100 — token minting and PDF generation

Mint per client (skip an invoice that already has `riivo_paymenttoken`), call
`Invoice - Child - Generate PDF` (`be610dd6`) rather than the generator endpoint
directly, and abort that client cleanly if either fails — no message without its
document. Both blocks are lifted from the cadence flow `c430ace5`. The
`resolvedTouches` rows in the dry-run report are the input shape it consumes.

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
  **not yet filed as a bug.**
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
