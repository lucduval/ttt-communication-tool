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

## Closed PRDs (parent epics — all slices done)
- **PRD #39 (Batch Lease)** — slices #40–#43 all closed; closed the parent.
- **PRD #36 (Leads Select All 148→50)** — slices #37 & #38 closed; closed the
  parent. (It was briefly mis-listed here as a work item — it was already a finished
  PRD, implemented by the `materialiseExplicit` helper.)

## Next up: #32 — Contact Query: type the marketing-type filter as a dimension

PRDs #39 and #36 are done. The remaining open issues (#32–#35) are a Contact Query
sub-chain that retires the raw-OData escape hatch one dimension at a time. **#35**
(delete the raw `filter` passthrough + unify count/send) is explicitly *blocked by*
the typed-dimension slices; name-range (#31) is already done, leaving #32, #33, #34
as the blockers. They're independent of each other, so take the simplest first:
**#32**.

Promote **marketing type** (tax / accounting / insurance) from a client-built OData
string (`buildODataFilter()` → `riivo_taxmarketing eq true`, carried through Contact
Query's raw `filter` passthrough) to a **typed Campaign-filter dimension** owned by
Contact Query.

Acceptance (see `gh issue view 32` for full text):
- Marketing type is a typed field on the Campaign filter from the UI through to
  Contact Query.
- Contact Query emits the marketing clause; the `riivo_*marketing` field name appears
  only inside Contact Query (not hand-built by the client).
- Count and send both resolve it from the same typed value.

### Pointers
- This is the **Contact Query** module, not the send driver. The query core + dialect
  live under `convex/lib/` (see the closed Contact Query slices #2–#7, #31 for the
  established typed-dimension pattern, and `recipientSelection.ts` for the pure-module
  + `__tests__/` sibling style).
- After #32/#33/#34 land, #35 removes `ContactFilter.filter` / `CampaignFilters.filter`,
  deletes `buildODataFilter()` and the raw clause in `getChannelFilter()`, and routes
  count + send through one typed filter so they can't drift. Do #35 last.
- #34 (channel-eligibility) overlaps #33's WhatsApp opt-in flag — Contact Query should
  compose them without double-emitting. If doing both, #33 before #34 is cleaner.

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
