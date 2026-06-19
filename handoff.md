# Handoff — RALPH iteration

## Just completed: #46 — Recompute funnel + rewired counter writers

**Issue #46 closed.** Branch: `main`. Commit `0be0c34`.

Second slice of PRD #44 (Campaign Tally; chain #45 → #46 → #47). Made the
denormalised list projection (`sentCount` / `deliveredCount` / `failedCount` on
the campaign document) a **recomputed cache** of the Campaign Tally — never an
additively-accumulated counter. Kills the drift class where crash →
`markBatchFailed` → recover → re-run → `markBatchComplete` inflated the counters.

Changes by layer:
- **`convex/campaignBatches.ts`** (new helper, the seam): plain async
  `recomputeCampaignStats(ctx, campaignId)` — mirrors `recoverStuckBatchesImpl`
  (faked-`ctx`-testable). Reads the campaign's messages via the `by_campaign_status`
  index (iterating the 4 statuses), folds with `tallyCampaign`, and **sets** the
  three counters. Patches by id only — deliberately does **not** re-read the
  multi-MB campaign doc (preserves the bounce read-budget guarantee).
- **`markBatchComplete` / `markBatchFailed`** (`campaignBatches.ts`): the additive
  `+=` patches are gone, replaced by `recomputeCampaignStats`. `markBatchFailed` no
  longer charges the whole batch as failed — recipients already flushed `"sent"`
  stay sent; the rest are restored by the recovery re-run.
- **`convex/bounces.ts::recordBounces`**: extracted a testable
  `recordBouncesImpl(ctx, bounces)`. Per-message `"failed"` patches land first, then
  **one recompute per affected campaign**. The `failedDelta` / `deliveredDelta`
  arithmetic is gone — a `delivered`→`failed` flip lowers `delivered` / raises
  `failed` for free via the tally.
- **`convex/campaigns.ts`**: removed the dead additive `updateStats` mutation (no
  callers, existed only to add).
- **Recovery sweep** (`recoverStuckBatchesImpl`): already wrote no counts (only
  flips dead batches to `pending`) — left as-is, now the only correct behaviour.
- **`convex/__tests__/recomputeCampaignStats.test.ts`** (new, 6 tests): counts ==
  tally of seeded statuses; recompute overwrites (not increments); replay & recover
  + re-run leave counts unchanged; a bounce lowers `delivered` / raises `failed`;
  bouncing an already-failed recipient is idempotent.

**Verification:** `npm run typecheck` clean; `npm run test` = 1474 passed (6 new;
worktree-duplicated copies inflate the count). `npx convex codegen` produced no
generated-file diff (removed mutation only).

## Next up: #47 — One-time backfill migration to correct drifted campaigns

**#47 is unblocked** (#46 done). Last slice of PRD #44. A one-time migration that
recomputes **every existing** campaign's counters from the Campaign Tally, so
historically drifted campaigns (e.g. list showing `968 Delivered / 3301 Failed`
against a true `4667 sent / 0 delivered / 2 failed`) are corrected on deploy —
not just campaigns sent after #46.

Acceptance (see `gh issue view 47` for full text):
- Migration lives in **`convex/migrations/`** and follows the
  **`migrateCampaignContent`** pattern (`convex/migrations/migrateCampaignContent.ts`).
- Iterates **all** campaigns and **sets** each one's counters to the tally values
  by calling the same `recomputeCampaignStats`.
- Test: a drifted campaign (counters disagreeing with its messages) is corrected to
  the tally values after the migration runs.

### Pointers (reuse, don't reinvent)
- **`convex/campaignBatches.ts::recomputeCampaignStats(ctx, campaignId)`** is the
  funnel #46 built — the migration just calls it per campaign. Already a plain
  exported async fn, so it works straight from a migration `internalMutation`.
- **`convex/migrations/migrateCampaignContent.ts::migrateBatch`** is the pattern to
  mirror: an `internalMutation` with `{ batchSize?, skip? }` args that processes a
  bounded slice per invocation (`.query("campaigns").order("desc").take(skip + batchSize)`)
  and returns `{ migrated, done }` so it can be called repeatedly until `done: true`.
  Stay within Convex mutation limits — keep `batchSize` small. Idempotent by
  construction (recompute SETS), so re-running is safe.

### Tests / prior art
- Fake-`ctx` harness: **`convex/__tests__/recomputeCampaignStats.test.ts`**
  (this slice) and **`convex/__tests__/recoverStuckBatches.test.ts`** both model a
  Convex `ctx` over in-memory arrays — mirror for the migration test. Seed a campaign
  whose stored counters disagree with its messages, run the migration, assert the
  counters now equal `tallyCampaign(messages.map(m => m.status))`.

### Campaign Tally area notes
- The `messages` table is the source of truth; per-recipient status is written
  idempotently. The campaign-document counters are a recomputed cache only.
- The `by_campaign_status` compound index is the read path for a campaign's messages.
- `CONTEXT.md`'s "Campaign Tally" section already describes the full funnel (it was
  written ahead of #46); no doc change was needed this slice.

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
