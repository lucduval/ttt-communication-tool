# Runbook: bad-debt recovery touches

_Operating note for `Invoice - Scheduled - Send Bad Debt Recovery Touches`.
Written for whoever is looking at a run that does not look right, not for
whoever is building the next slice — that is `docs/handoff-bad-debt-automation.md`._

The flow selects clients with open bad debt, works out which of 24 approved
WhatsApp templates each one is due, mints a payment link, renders their invoice
PDF, and sends on both channels. It runs **Monday and Thursday at 09:45 SAST**,
unattended.

---

## 1. Stopping it

**Set the environment variable `riivo_BadDebtEnabled` to `no`.** That is the
kill switch. Anything other than `no` — including blank — means running.

| | |
|---|---|
| **Who can** | Anyone who can edit an environment variable in the environment. No flow ownership, no maker-portal rights over the flow, no deploy. |
| **Where** | Power Apps maker portal → Solutions → **4Variables** → `Bad Debt Enabled` → set the **current value** (not the default) to `no`. Or `PATCH environmentvariablevalues(<id>)`. |
| **How fast** | The next scheduled run ends before it selects anybody. A run **already in flight** stops sending at the next client — the switch is re-read once per client, not once per run. |
| **Confirm it worked** | A "SWITCHED OFF" or "STOPPED PART-WAY" email arrives at `riivo_varFlowErrorTeamMail`. A skipped run shows as **Cancelled** in run history and writes no `riivo_baddebtrun` row. |

**What it does not undo.** Clients the run had already reached keep their
touch: their `riivo_campaignsendcount` has advanced and the next run will not
message them again. That is correct — they did receive the message. The clients
it had not yet reached are held, listed in the report, and selected again by the
next run that finds the switch back on. Nothing needs unwinding by hand.

**Turning it back on** is the same edit in reverse. No redeploy, no flow edit;
the next scheduled run resumes on its own.

### The other two levers, and why they are second choices

| Lever | Effect | Why not first |
|---|---|---|
| Deactivate the flow (maker portal) | Stops all future runs | **Connection-gated to riivo Admin** in this org, and does not stop a run already in flight |
| Cancel the running instance (run history) | Stops that one run | Same ownership gate; stops one run, not the campaign |
| `riivo_ReminderTestMode` = `true` | Next run selects and reports but sends nothing | Only takes effect on the **next** run; changes what the run means, not whether it happens |

If the campaign is left switched off, you get the notice again every Monday and
Thursday. That is deliberate: a campaign that has quietly stopped chasing money
looks exactly like one that is running and finding nobody to chase.

---

## 2. What a healthy run looks like

`Compose_|_Dry_Run_Report`, at the end of the run, is the one place that carries
everything. The `riivo_baddebtrun` row is the same story in a form that survives
the run history expiring.

| Field | Healthy |
|---|---|
| `killSwitch` | `yes` |
| `killSwitchLiveRead` | `true` — see §4 if it is false |
| `tripwireVerdict` | `proceed` |
| `stoppedMidRun` | `0` |
| `canaryClients` | `0` in normal operation. Non-zero means the campaign is speaking **only** to those clients |
| `selectedClients` | Within `riivo_BadDebtVolumeChangeThresholdPercent` of the previous run |
| `resolvedTouches` + `heldTouches` | Sums to `selectedClients` |
| `emailsSent` / `whatsAppsSent` | Close to `resolvedTouches`; never summed together, because the channels fail for different reasons |
| `durationSeconds` | Compare to the last few runs. Growing is the signal |
| `throttleWaits` | `0` normally. Non-zero explains a long run before you blame the flow |

Held rows are **not** failures. Every one carries a `reason`, and a client that
is held today is simply selected again next run.

---

## 3. Where failures surface

Five places, in the order worth checking:

1. **Email to `riivo_varFlowErrorTeamMail`** (`233fd44c.riivo.io@za.teams.ms`).
   Every parked run, every canary run, every switched-off or stopped run. The
   subject always begins "Flow Failure:" — the house alert child hardcodes it —
   so read the rest of the line, which says whether it actually is one.
   **These send even while `riivo_SendEmail` is off.** The alert child does not
   consult it, so the org-wide switch that turns every other flow's mail into a
   draft does not silence safety alerts. Verified on the parked run of
   2026-09-14: status Sent, `senton` stamped, in an environment where
   `riivo_SendEmail` was `no`. That is the fail-safe direction, and it is why a
   parked run reaches a human in dev at all.
2. **Run history** on the flow. Red = a real failure or a tripwire park.
   **Cancelled** = the kill switch. Expires, which is why the two below exist.
3. **`riivo_baddebtrun`** — one row per run, including parked ones. Counts,
   outcome, duration, throttle waits. This is the run-over-run record.
4. **`riivo_whatsappcommunications`** — one row per WhatsApp attempt, sent *or*
   refused. A failed row carries Meta's own words in `riivo_failurereason`.
   Read it rather than guessing.
5. **The client's timeline** — the email row and its attachment, the WhatsApp
   row. What the client actually received.

---

## 4. When a run looks wrong

**Nothing was sent, and the run is red.**
The volume tripwire parked it. The alert carries both counts and the threshold;
the `riivo_baddebtrun` row says `outcome=aborted` with the same words in
`riivo_abortreason`. Nothing was minted or rendered — a parked run produces
nothing. Decide which is true: if the new population is real, set that row's
`riivo_outcome` to `accepted` and the next run compares against it; if it is
not, fix the data. **Do not loosen the threshold to let one run through** — that
is the temporary change that becomes permanent.

**Nothing was sent, and the run is Cancelled.** The kill switch. §1.

**The run only messaged a handful of people.**
Check `canaryClients` in the report and `riivo_BadDebtCanaryContactIds`. While
that list is non-empty the campaign speaks only to those clients. This is the
most likely cause of a campaign that looks alive and is reaching nobody. Its
"off" value is `[]`, the empty list — **never blank it**: Dataverse stores no
empty default, and a variable with neither a default nor a value cannot be
bound, so the flow fails every run with "Attribute 'value' was not found".

**Everyone was held.**
Read one held row's `reason` — they will nearly all be the same. Common causes:
payment links switched off (`riivo_PaymentLinkEnabled`), so every template's
Pay-now button would point at a dead endpoint; the mint endpoint or the PDF
child failing; the campaign switched off part-way.

**Emails show as created but nobody received one.**
`riivo_SendEmail` is `no`. It is **org-wide** and read by 71 flows: with it off
the branded-email child saves every mail as a draft. The report says which,
in `emailSendingEnabled`, and each touch row carries a note. Turning it on arms
16 other live event-triggered flows for as long as it is on.

**A WhatsApp arrived but the document will not open.**
The PDF was uploaded as base64 *text* rather than bytes. This build uses the
braceless `@base64ToBinary(…)` form and a test pins it, so this should not
recur — but it is the known failure mode, and only a handset shows it.

**The Pay-now button 404s.**
Expected in dev. Meta bakes the URL prefix into each template at approval time,
and dev's `riivo_PaymentLink_BaseUrl` is a different host. The 24 campaign
templates point at `payment-link-ttt.azurewebsites.net`; the D12 fallback points
at dev's host — so one of the two is wrong in whichever environment you are in.
No flow change fixes it: either re-approve the templates against one host, or
point both environments at one payment-link app. `--check` prints both and says
so. To verify a token by hand, read it from the run report and load
`{riivo_PaymentLink_BaseUrl}/p/{token}`.

**`killSwitchLiveRead` is `false`.**
The per-client re-read of the switch cannot see the environment-variable value
table here. The campaign can still be stopped **between** runs; it cannot be
stopped **part-way through** one. Treat it as a real gap and fix the read before
the next unattended cycle — everything else in §1 still applies.

**Every run fails immediately with "Attribute 'value' was not found for
environment variable X".**
That variable has neither a value row nor a default, so Power Automate cannot
bind it — before any expression in the flow gets the chance to default it away.
A defensive `coalesce` in the flow does not help, because the failure is in the
binding, not the reading. Give it a default (or a value);
`bash flows/deploy-bad-debt-touches.sh --check` reports any variable in this
state as `*** NO VALUE AND NO DEFAULT ***`, and `--replace` repairs it.

**The run took much longer than usual.**
Read `throttleWaits` beside `durationSeconds` on the run row. Non-zero means
Meta or the mint endpoint asked us to slow down and the run waited exactly as
long as it was told. Zero, with a longer duration, means something else — start
with the selected count.

**A client was messaged twice in one run.**
Should be impossible: selection collapses to one row per client before anything
is sent, and a test pins it. Check whether two runs fired rather than one — the
`riivo_campaignlastsent` recency gate (`riivo_BadDebtMinDaysBetweenTouches`,
default 2 days) is the only defence against a retry, because Power Automate has
no transactions.

---

## 5. Known, accepted, not bugs

- **No draft mode for WhatsApp.** One TTT business number, no sandbox, and dev
  posts to the same Meta phone number id as prod. A run that is not in test mode
  sends real messages. Test mode and the canary list are the whole safety
  envelope.
- **A run that aborts or canaries is never a baseline** for the next run's
  volume comparison. Only `proceeded` and `accepted` are.
- **WhatsApp consent is read once**, at selection, while email is checked again
  by the child at send time. Someone who opts out mid-run may still get that
  run's WhatsApp; they are excluded from the next one.
- **The house failed-flow alert child cannot be switched off** — it sends in
  both branches of its own on/off condition, org-wide, in 218 flows.
