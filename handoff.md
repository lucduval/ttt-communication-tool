# Handoff — RALPH iteration

## Just completed: #43 — Channel Send flush write-rate-limit resilience (PRD #39, final slice)

**Issue #43 closed.** Branch: `main`.

Fourth and final slice of PRD #39 (*campaigns must never silently stall mid-send*).
With #42 dropping the recovery cron to 1 min, a batch that died on a `TooManyWrites`
write wall would thrash a reap→re-kill loop every ~2–3 min and never drain. This
gives recovery something stable to retry into. **PRD #39's slices (#40–#43) are now
all done — #39 itself (the parent epic) is a candidate to close after review.**

Two defects fixed in **`convex/lib/channelSend.ts`** (the driver):
- **Error path stranded the batch.** When a flush threw `TooManyWrites`, the buffer
  wasn't cleared (it's cleared only after the write lands), so the `catch`'s second
  `flush()` re-threw the same error before `handleBatchError` could run → batch
  stuck in `processing`, no successor. Fixed two ways:
  - `flush()` now **retries the same buffer on `TooManyWrites`** with exponential
    backoff (`FLUSH_MAX_RETRIES = 5`, `FLUSH_BACKOFF_BASE_MS = 250`, doubling). The
    buffer is cleared only once the write lands. A non-rate-limit error, or an
    exhausted retry budget, propagates to the catch.
  - The **catch-path flush is now best-effort** (wrapped in its own try/catch that
    logs and swallows), so `handleBatchError` *always* runs — the batch ends
    failed/recoverable with a scheduled successor, never stranded.
- **Aggregate throughput.** The backoff-retry doubles as *reactive pacing*: when
  concurrent workers/webhooks saturate the deployment-wide 4 MiB/s ceiling, each
  flusher backs off and spreads its writes out instead of hammering the wall. Self-
  tuning — no fixed per-send delay penalising healthy campaigns.
- New exports for testing/reuse: `isTooManyWrites(err)`, `FLUSH_MAX_RETRIES`,
  `FLUSH_BACKOFF_BASE_MS`. `runChannelSend` gained an injectable `sleep?` arg
  (mirrors the `now?` injection) so tests pay no real wall-clock for backoff.
- **`convex/lib/__tests__/channelSend.writeLimit.test.ts`** (new, +3 tests): flush
  trips `TooManyWrites` once then lands on retry (batch completes, progress
  preserved); every flush trips it (batch not stranded — `markBatchFailed` +
  successor scheduled); adapter throws *and* the catch-path flush keeps tripping
  (still reaches `handleBatchError`).

**Verification:** `npm run typecheck` clean; `npm run test` = 1445 passed (+3).

## Next up: #36 — Leads "Select All" count collapses 148 → 50 on the summary step (bug)

PRD #39 is complete, so the next highest-priority unblocked issue is **#36**, a
silent-data-loss bug: a consultant clicks **Select All (148)** on the Leads
audience, the recipients step shows "148 selected", but the summary step reads "50
Recipients" and the campaign is sent to only 50. The same loss affects manual
cross-page lead selection (leads checked on page 2+ are dropped on navigation
because only the first page of lead records is retained for materialisation).

Acceptance (see `gh issue view 36` for full text):
- Select All (148) on Leads → summary reads "148 Recipients" → all 148 are sent.
- Hand-picking leads across multiple loaded pages survives navigation forward.

### Pointers
- This is the **recipients/materialisation** path, not the send driver. Recent
  related work: `materialiseExplicit` helper (#37) and its navigation wiring (#38) —
  see `git log` and `convex/lib/recipientSelection.ts` (pure-module + `__tests__/`
  sibling pattern). Start there to see how the selection is resolved into recipients.
- The "50" smells like a default page size / first-page-only fetch leaking into the
  authoritative selection. Trace where Select-All produces a count vs. where the
  summary/send re-derives the recipient set.

### If picking up Batch Lease (#39) area work again
- The pure predicate is **`convex/lib/batchLease.ts`** — import `isDead` /
  `lastBeat` / `shouldBeat` and the constants from here; do not re-derive timings.
- **Registered Convex mutations don't expose `.handler`** for unit tests. The
  established pattern (`runChannelSend`, `recoverStuckBatchesImpl`) is to extract a
  plain exported `fooImpl(ctx, now = Date.now)` that the registered wrapper delegates
  to, then drive it against a faked `ctx`. The driver also now takes `sleep?` for
  backoff injection.
- The lease is fully wired: `markBatchProcessing` seeds it, the driver beats via
  `beatBatch`, the sweep reaps via `isDead`, and the flush path is rate-limit-safe.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Update this `handoff.md` when the next issue is done, in the same fashion** —
  rewrite "Just completed" for the issue you finished, move "Next up" to the
  highest-priority unblocked issue with the same concrete pointers.
- Note: vitest also picks up copies under `.sandcastle/worktrees/**` — harmless
  duplication in the test counts, ignore it.
