# Handoff — RALPH iteration

## Just completed: #45 — Campaign Tally pure module + detail view aligned

**Issue #45 closed.** Branch: `main`. Commit `b2af372`.

First slice of PRD #44 (Campaign Tally: single source of truth for campaign
delivery stats; chain #45 → #46 → #47). Established the one seam that owns the
status→count rule, so the detail view and the (later) list projection cannot
diverge.

Changes by layer:
- **`convex/lib/campaignTally.ts`** (new, the deep place): `tallyCampaign(statuses)`
  folds an `Iterable<string>` of per-recipient message statuses into the canonical
  `{ sent, delivered, failed, pending }`. Pure — no `ctx`, no DB. `sent` = `"sent"`
  **plus** `"delivered"`; `delivered` = `"delivered"` only; empty → all zeros;
  unknown statuses drop to no bucket (deterministic). Takes a plain status
  collection (not a query result) so #46/#47 reuse the same seam. Mirrors
  `lib/batchLease.ts`.
- **`convex/lib/__tests__/campaignTally.test.ts`** (new): truth-table over the
  status→bucket mapping + edge cases (empty, sent-includes-delivered, unknown
  statuses, non-array iterable).
- **`convex/messages.ts::getCampaignStats`**: rewired to collect the campaign's
  messages via `by_campaign` and apply the tally. The inline `sent + delivered`
  arithmetic and the 4 per-status index counts are gone. Detail numbers unchanged.
- **`CONTEXT.md`**: folded in the pre-existing "Reporting / Campaign Tally" section
  (it specified this module as if it existed; it now does).
- **`convex/_generated/api.d.ts`**: regenerated (`npx convex codegen`) — registers
  `lib/campaignTally`; also carries the prior `lib/batchLease` registration that was
  missing from the committed generated file.

**Verification:** `npm run typecheck` clean; `npm run test` = 1468 passed
(worktree-duplicated copies inflate the count).

## Next up: #46 — Recompute funnel + rewire all counter writers + recovery sweep

**#46 is unblocked** (#45 done). Make the denormalised list projection
(`sentCount` / `deliveredCount` / `failedCount` on the campaign document) a
**recomputed cache** of the Campaign Tally — never an additively-accumulated
counter. Kills the drift class where crash → `markBatchFailed` → recover →
re-run → `markBatchComplete` inflated the counters.

Acceptance (see `gh issue view 46` for full text):
- Add an internal helper `recomputeCampaignStats(ctx, campaignId)`: reads the
  campaign's messages (via `by_campaign_status` index), runs the Campaign Tally,
  and **sets** the three counters on the campaign document. It overwrites; it
  never adds.
- Replace every additive (`+=`) counter mutation with the recompute funnel:
  - `markBatchComplete` (batch settle, success) → recompute.
  - `markBatchFailed` (batch settle, failure) → recompute.
  - `recordBounces` → recompute once per affected campaign, after the per-message
    status patches.
  - Recovery sweep (recover-stuck-batches) → **stops writing counts entirely**;
    it only resets dead batches to `pending`. Next batch settle restores counts.
- Realign `sentCount`'s prior meaning ("attempted" = success+failed) to the
  tally's `sent` definition so list and detail agree.
- No schema changes; messages table stays the only source of truth; per-recipient
  status writes stay idempotent.

### Pointers (exact `+=` sites to retire)
- **`convex/campaignBatches.ts:230–232`** — `markBatchComplete`: currently
  `sentCount += successCount + failedCount`, `deliveredCount += successCount`,
  `failedCount += failedCount`. Replace with `recomputeCampaignStats`.
- **`convex/campaignBatches.ts:293–294`** — `markBatchFailed`: `failedCount +=`,
  `sentCount +=` over `batch.recipients.length`. Replace with recompute.
- **`convex/bounces.ts:238–240`** — `recordBounces`: `failedCount += failedDelta`,
  `deliveredCount = max(0, deliveredCount + deliveredDelta)`. Replace with one
  recompute per affected campaign, **after** the per-message status patches land.
- **`convex/campaigns.ts:174–176`** — the `updateCampaignStats`-style additive
  mutation (`(campaign.sentCount||0) + args.sentCount`, etc.). Check callers; if it
  exists only to add, it should funnel through recompute or be removed.
- **Recovery sweep** lives in **`convex/campaignBatches.ts`** (the
  `recoverStuckBatches` mutation, scheduled from `convex/crons.ts`); it uses
  `lib/batchLease.isDead`. It must flip dead batches to `pending` only — **no count
  writes**.

### Pointers (the tally seam to reuse)
- **`convex/lib/campaignTally.ts::tallyCampaign(statuses)`** is the shared rule —
  feed it the campaign's message statuses (`messages.map(m => m.status)`).
- **`getCampaignStats`** (`convex/messages.ts`) is the worked example of "collect
  messages → map to statuses → tally" — mirror its read for the helper, but use the
  `by_campaign_status` index per the acceptance text (it iterates the 4 statuses).

### Tests / prior art
- Regression: replaying a batch settle, or recovering + re-running a batch, leaves
  counts unchanged. **Prior art: `convex/__tests__/recoverStuckBatches.test.ts`**
  (faked `ctx`). Mirror its fake-ctx harness.
- Regression: a bounce lowers `delivered` / raises `failed` consistently.
- Test: counts produced == tally of the seeded messages for a given status set.

### Campaign Tally area notes
- #47 (last slice, blocked by #46) is a one-time backfill migration over all
  campaigns that calls the same recompute funnel.
- The `messages` table is the source of truth; each recipient's status is written
  idempotently. The counters on the campaign document are a recomputed cache only.
- The `by_campaign_status` compound index is the read path for a campaign's messages
  (see `convex/messages.ts` and `convex/campaignBatches.ts`).

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit
  scoped to the issue's files (don't sweep in unrelated working-tree changes).
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Update this `handoff.md` when the next issue is done, in the same fashion** —
  rewrite "Just completed" for the issue you finished, move "Next up" to the
  highest-priority unblocked issue with the same concrete pointers.
- Note: vitest also picks up copies under `.sandcastle/worktrees/**` — harmless
  duplication in the test counts, ignore it.
