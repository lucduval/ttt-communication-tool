# Handoff — RALPH iteration

## Just completed: #41 — Write heartbeats: claim lease + `beatBatch` mutation + driver emit path (PRD #39)

**Issue #41 closed.** Branch: `main`.

Second slice of PRD #39 (*campaigns must never silently stall mid-send*). Wires
the pure Batch Lease predicate (#40) into the **write side** of the live send
path: a claim now establishes a lease, and the Channel Send driver bumps it as
results stream, throttled so writes stay bounded across every channel. The
recovery/reaper side (reading `isDead`) is still **not** wired — that's #42.

What landed:
- **`convex/campaignBatches.ts`**
  - `markBatchProcessing` now sets `heartbeatAt = claimedAt` alongside
    `startedAt` on the `pending → processing` transition, so a freshly claimed
    batch has a live lease *before* its worker's first emit.
  - New `beatBatch` internal mutation — patches `heartbeatAt = Date.now()` on
    the batch. One-line patch; called only by the driver, throttled there.
- **`convex/lib/channelSend.ts`** (the driver)
  - `runChannelSend` takes an optional injected clock `now?: () => number`
    (defaults to `Date.now`) so heartbeat throttling is unit-testable. Used for
    both the heartbeat check and `sentAt` in flush.
  - Seeds `lastBeatAt = now()` right after the claim (the claim's
    `heartbeatAt` is the initial lease).
  - In the serialised `emit` chain, after appending/flushing results, calls
    `shouldBeat(lastBeatAt, now())` (from `lib/batchLease`); when true, bumps
    `lastBeatAt` and calls `internal.campaignBatches.beatBatch`. The beat
    piggybacks on the existing 25-recipient flush mechanism — **adapters stay
    thin and never touch the heartbeat**. Bounds writes to ≤1 / ~30s for both
    per-recipient channels (email/personalised) and the WhatsApp ≤1000 path.
- **`convex/lib/__tests__/channelSend.test.ts`** (+2 driver tests)
  - "initial lease from claim" — a short batch emitting within one window issues
    **no** `beatBatch` (lease already live from the claim).
  - "≤1 beat per throttle window" — 60 emits spanning ~2 windows produce exactly
    2 beats, not 60. Drives the injected clock; window size taken from the
    imported `HEARTBEAT_THROTTLE_MS`, not a hardcoded number.

**Verification:** `npm run typecheck` clean; `npm run test` = 1437 passed.

## Next up: #42 — Heartbeat-aware recovery sweep + faster cron (PRD #39)

#42 is unblocked now (#41 done). It's the **read side** of the lease — the
operator-facing payoff:
- In `recoverStuckBatches` (`convex/campaignBatches.ts` ~L520), replace the
  `startedAt < now - 20min` test with `isDead(batch, now)` from
  `lib/batchLease`. Death keys on last progress (`heartbeatAt`), so a
  slow-but-alive emitting worker is never falsely revived. Pre-heartbeat batches
  stay recoverable via the `startedAt` fallback in `lastBeat`.
- Drop the `recover-stuck-batches` cron interval from 5 min to ~1 min (find it
  in `convex/crons.ts`).
- **Keep the single-worker guards unchanged**: one worker per affected campaign,
  skip if another batch is still `processing`.
- Tests assert relative lease/throttle ordering, not the exact `LEASE_MS` /
  `HEARTBEAT_THROTTLE_MS` numbers.

**Note:** #43 (Channel Send flush exceeds Convex write-rate limit / strands the
batch on error) does **not** block #42 but "should land alongside" it — once
recovery is fast, a batch that dies on a `TooManyWrites` write wall would
thrash a reap→re-kill loop. Consider doing #43 immediately after #42.

### If picking up new work in this area
- The pure predicate is **`convex/lib/batchLease.ts`** — import `isDead` /
  `lastBeat` / `shouldBeat` and the constants from here; do not re-derive
  timings. Pure-module + `__tests__/` sibling pattern (as `retry.ts`,
  `recipientSelection.ts`).
- The write side is now live: `markBatchProcessing` seeds the lease, the driver
  in `lib/channelSend.ts` beats via `beatBatch`. #42 only adds the reaper read.
- The batch row shape lives in `convex/schema.ts` → `campaignBatches`
  (`status`, `startedAt`, `heartbeatAt`, the `by_status` /
  `by_campaign_status` indexes).

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
