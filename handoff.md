# Handoff — RALPH iteration

## Just completed: #61 — WhatsApp + personalised adopt the markAttempted seam

**Issue #61 closed.** Branch: `main`.

Extended the at-most-once send guarantee (PRD #55) from email to the other two
channels, so it is **owned in one seam** (eligibility rule #56 + `attempted`
marker #58) and inherited per-adapter rather than re-implemented. Both adapters
now take the driver's `eligible` set + `markAttempted` closure (the signature
already declared them; the two adapters simply ignored them until now).

**Changes — `convex/channelSenders.ts` only (source):**
- **WhatsApp** (`sendWhatsAppBatch_`): iterates `eligible` instead of
  `batch.recipients` (CRM-field fetch too), and calls `markAttempted([id])`
  **inside the rate-limiter slot**, immediately before `sendTemplateWithRetry`.
  Marking inside the slot (not before scheduling the whole `Promise.all`
  fan-out) means only recipients the limiter has actually released to send are
  marked — a mid-batch action kill strands at most the in-flight recipients in
  `attempted`, not the entire queued list. Invalid-phone / aborted recipients
  are never marked (never handed to Meta).
- **Personalised** (`sendPersonalisedBatch_`): iterates `eligible`, calls
  `markAttempted([id])` immediately before `sendEmail`, and **drops its own
  up-front `messages.createBatch`** — the seed `createBatches` already writes a
  `pending` row per recipient (#63) and `markAttempted` advances it, so the row
  the click/open-tracking + `setOpportunityId` reconciliation depends on still
  exists throughout. This makes it match the email seam exactly (adapter creates
  no rows itself). The cross-campaign `personalisedHistory.recordSentBatch`
  dedup is orthogonal and untouched.

**Tests:**
- `convex/__tests__/whatsappSender.test.ts` + `personalisedSender.test.ts`: new
  unit tests assert each adapter sends **only the eligible subset** and calls
  `markAttempted` for exactly that recipient **before** the provider send (order
  asserted via a shared interleaving array); plus WhatsApp does not mark an
  invalid-phone recipient, and personalised no longer emits `messages:createBatch`.
- **New file `convex/__tests__/sendSeamAtMostOnce.channels.test.ts`**: the
  headline at-most-once proof for both channels, wiring the **real** seam pieces
  (`eligibleRecipients` #56 + `markAttemptedBatchImpl` #58 + the real adapter)
  around a stateful in-memory `messages` store, faking only each channel's
  provider boundary. `runOnce` mirrors the driver's per-batch control flow
  (compute eligible → mark → run adapter → settle emitted results). Precondition
  set up directly (one recipient already `failed` from an ambiguous provider
  response, one still `pending`), exactly like the email regression #62; asserts
  the recovery re-run resends the handled recipient **zero** times, completes the
  unfinished one, and leaves one row per recipient.

**Verified red-first:** `git stash`-ing `channelSenders.ts` turns the 4 new seam
assertions red (WhatsApp/personalised send both recipients, never mark), while
the 4 pre-existing behavioural tests stay green — then restored.

**Verification:** `npm run typecheck` clean; the 3 touched/new test files green
(8/8). Full suite: only the 3 known pre-existing `recomputeCampaignStats`
failures remain (unrelated `campaignTally` WIP — see below); 389 pass.

## PRD #55 status: seam work in dependency order (#56–#63)

| # | Issue | Blocked by | State |
|---|-------|-----------|-------|
| #56 | Eligibility rule + `attempted` status (seam **core**) | — | ✅ done |
| #57 | Kill in-call `$batch` per-item retry | — | ✅ done |
| #58 | `markAttempted` seam + email send lifecycle | #56 | ✅ done |
| #63 | `createBatches` pending rows collide with eligibility | — | ✅ done |
| #62 | Headline regression test (zero duplicates) | #56–#58, #63 | ✅ done |
| #61 | WhatsApp + personalised adopt the seam | #58 | ✅ done (this iteration) |
| #59 | Campaign Tally counts `attempted` as pending | #56 | **unblocked** |
| #60 | Operator-initiated resend to failed recipients | #56 | **unblocked** |

PRD parents **#55** and **#48** remain open (docs, not agent work). With #61
done, all three channels inherit the at-most-once seam. Only two extension
issues remain (#59 tally, #60 operator resend) — neither is core-seam work.

## Next up
- **#59 — tally counts `attempted` as pending**: fold the `attempted` status into
  the `pending` bucket in `tallyCampaign` so an in-flight recipient counts as
  pending, not sent/failed; both tally readers (detail recount + list projection)
  must treat it identically, and the recipient total must stay stable across a
  recovery re-run. ⚠️ **Touches `convex/lib/campaignTally.ts`, which carries
  unrelated uncommitted WIP** (see below) — coordinate/rebase before editing it,
  and the 3 pre-existing `recomputeCampaignStats` failures live there too.
- **#60 — operator-initiated resend of `failed`**: the explicit path that
  recovers a delivered-but-429 (`failed`) recipient automatic sending now
  correctly refuses to touch. Needs (a) a way to list genuinely-`failed`
  recipients for a campaign, (b) an explicit operator action that clears/ignores
  their `failed` rows so the eligibility rule makes them eligible again — with no
  automatic path ever doing this on its own. Independent of the campaignTally WIP.

## Environment / gotchas
- `node_modules` installed. Test runner is **vitest 4** via `npm run test` (or
  `npx vitest run <path>` for one file). Runs under the **`node`** environment.
- **Mutations are tested via extracted `Impl` fns + a faked `ctx.db`**, not
  `convex-test` (not a dep). Adapters are tested through their `sendBatch` seam
  with a faked `ctx` + module-mocked provider boundary (see the two
  `*Sender.test.ts` files). The driver is tested against a faked `ctx` — see
  `convex/lib/__tests__/channelSend.test.ts`.
- **End-to-end seam pattern**: `sendIdempotencyRegression.test.ts` (email, full
  driver + real sweep) and the new `sendSeamAtMostOnce.channels.test.ts`
  (WhatsApp/personalised, real eligibility + real markAttempted around the real
  adapter, provider faked) both build a stateful in-memory store and drive the
  real seam. Reuse either shape for further channel/seam work.
- **Pre-existing unrelated uncommitted changes** remain in the working tree and
  are **not mine** — leave them alone: `convex/lib/campaignTally.ts` +
  `convex/lib/__tests__/campaignTally.test.ts` (a `delivered = sent`
  redefinition), a matching **`convex/messages.ts` comment hunk** (the
  `delivered – sent minus bounces` block near line 41), `convex/backfill.ts`,
  `.sandcastle/prompt.md`, and untracked `docs/email-template-design-research.md`.
- ⚠️ Those uncommitted campaignTally changes make **3 tests fail** in
  `convex/__tests__/recomputeCampaignStats.test.ts` (bounce ⇒ delivered/failed
  counts). Confirmed pre-existing — my slice never touches those counts. Full-suite
  `npm run test` is therefore **not green** until that WIP is finished or reverted.
  Don't attribute those 3 failures to your slice.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing — but the
  campaignTally failures above are a known pre-existing exception; verify *your*
  files' tests pass and don't regress anything else.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit
  scoped to the issue's files (use `git add -p` when a file mixes your change with
  pre-existing WIP).
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Rewrite this `handoff.md` when the next issue is done.**
