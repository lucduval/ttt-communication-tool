# Handoff — RALPH iteration

## Just completed: #42 — Heartbeat-aware recovery sweep + faster `recover-stuck-batches` cron (PRD #39)

**Issue #42 closed.** Branch: `main`.

Third slice of PRD #39 (*campaigns must never silently stall mid-send*). This is
the **read side** of the lease — the operator-facing payoff. Recovery now keys on
last progress (`heartbeatAt`) instead of claim time, and runs ~5× more often, so a
campaign drains to completion on its own within ~2–3 min of any worker death — no
pause/unpause ritual.

What landed:
- **`convex/campaignBatches.ts`**
  - New plain `recoverStuckBatchesImpl(ctx, now = Date.now)` — the recovery sweep
    extracted with an injected clock so the reap decision is unit-testable (mirrors
    `runChannelSend`'s `now?` injection). The registered `recoverStuckBatches`
    internalMutation now just delegates to it.
  - Reap test swapped from `startedAt < now - 20min` to **`isDead(batch, now)`**
    (from `lib/batchLease`). Death keys on `lastBeat` (heartbeat, or `startedAt`
    fallback for pre-heartbeat batches), so a slow-but-alive emitting worker is
    never falsely revived; pre-heartbeat batches stay recoverable.
  - **Single-worker guards unchanged**: one worker per affected campaign, skip if
    another batch for that campaign is still `processing`.
- **`convex/crons.ts`**
  - `recover-stuck-batches` interval dropped **5 min → 1 min**. Recovery latency is
    now ≈ cron interval + lease (~2–3 min) instead of ~25 min.
- **`convex/__tests__/recoverStuckBatches.test.ts`** (new, +5 tests)
  - Drives `recoverStuckBatchesImpl` against a faked `ctx` (db + scheduler). Covers:
    stale-heartbeat reaped + one worker kicked; fresh batch untouched; ≤1 worker per
    campaign with several dead batches; "another batch still processing" skip
    preserved; pre-heartbeat batch reaped via `startedAt` fallback. Times are
    offsets from `LEASE_MS` (e.g. `NOW - LEASE_MS - 1000`), never the raw constant —
    asserts relative lease ordering, not tuning numbers.

**Verification:** `npm run typecheck` clean; `npm run test` = 1442 passed.

## Next up: #43 — Channel Send flush exceeds Convex write-rate limit / strands the batch on error (PRD #39)

#43 does **not** block anything but "should land alongside #42" — now that recovery
is fast (1-min cron), a batch that dies on a `TooManyWrites` write wall would thrash
a reap→re-kill loop every ~2–3 min and the campaign never drains. Recovery needs
something stable to retry into. **Do this next.**

Two distinct defects to fix in **`convex/lib/channelSend.ts`** (the driver):
- **Error path strands the batch.** When `updateStatusBatch` throws `TooManyWrites`
  inside the `try`, the `catch` calls `flush()` *again* on the same still-full
  buffer → throws the same error → `handleBatchError` never runs, the action exits
  by throwing, the batch stays `processing`, no successor scheduled. Fix: the catch
  must not re-run a flush guaranteed to throw before it can mark the batch
  failed/reschedule. Either back-off-and-retry the flush, or run `handleBatchError`
  so the batch ends recoverable/failed with a scheduled successor.
- **Aggregate flush throughput exceeds 4 MiB/s.** `updateStatusBatch` flushes every
  `FLUSH_INTERVAL` (25) recipients; the WhatsApp ≤1000 path fires ~40 back-to-back,
  and concurrent campaigns/webhook writes share the deployment-wide ceiling. Bound
  concurrently-flushing workers and/or pace the high-fan-out WhatsApp flushes.

Acceptance (see `gh issue view 43` for full text):
- A send that previously tripped `TooManyWrites` completes within the write limit.
- A flush hitting `TooManyWrites` never silently strands the batch in `processing`.
- The catch-path no longer re-throws from a second `flush()` before `handleBatchError`.
- Regression test: drive the driver with a flush that throws `TooManyWrites`; assert
  the batch isn't stranded and partial progress is preserved.

### If picking up new work in this area
- The pure predicate is **`convex/lib/batchLease.ts`** — import `isDead` /
  `lastBeat` / `shouldBeat` and the constants from here; do not re-derive timings.
  Pure-module + `__tests__/` sibling pattern (as `retry.ts`, `recipientSelection.ts`).
- **Registered Convex mutations don't expose `.handler`** for unit tests. The
  established pattern (as `runChannelSend`, now `recoverStuckBatchesImpl`) is to
  extract a plain exported `fooImpl(ctx, now = Date.now)` that the registered wrapper
  delegates to, then drive it against a faked `ctx` from `convex/__tests__/`.
- The lease is fully wired now: `markBatchProcessing` seeds it, the driver in
  `lib/channelSend.ts` beats via `beatBatch`, and the sweep reaps via `isDead`.
- The batch row shape lives in `convex/schema.ts` → `campaignBatches` (`status`,
  `startedAt`, `heartbeatAt`, the `by_status` / `by_campaign_status` indexes).

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
