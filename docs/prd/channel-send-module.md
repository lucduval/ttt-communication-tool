# PRD — Deepen the Channel Send module

_Status: ready-for-agent · Source: architecture review (Candidate 1), 2026-06-17_

## Problem Statement

When the product sends a queued campaign, the email, WhatsApp, and personalised paths run as three separate batch processors that share the same lifecycle skeleton but were copy-pasted and have quietly drifted. The three-way channel branch is duplicated verbatim in five places, and two further bulk-send paths reimplement the whole pipeline outside the queue (they are now dead code, bound in the UI but never invoked).

Because the lifecycle is duplicated rather than shared, correctness-relevant behaviour differs by channel for no decided reason:

- The email path flushes per-recipient results to the database every 25 recipients so an 8,000-recipient campaign survives a mid-batch crash. The WhatsApp and personalised paths flush only once at the end, so a crash mid-batch silently loses a whole batch's worth of progress.
- When a worker loses the race to claim a batch, the email path reschedules itself to keep the worker pool stable; the WhatsApp path simply returns. Same race, two behaviours.

Any change to batching, retry, pacing, idempotency, or status writing has to be made in three places and kept in sync, and the absence of a channel seam means there is no single place to test "what happens to a batch" independent of which channel it is.

## Solution

Introduce a single **Channel Send** module that owns the batch lifecycle, and a **Channel Sender** adapter per channel that owns only that channel's per-recipient send loop and side-effects.

From the operator's and developer's perspective:

- A campaign sends identically regardless of channel where the behaviour should be identical (claiming a batch, surviving a crash, scheduling the next batch, marking complete or failed), because that logic lives in one driver.
- A mid-batch crash on a WhatsApp or personalised campaign no longer loses the batch's progress — crash-survival flushing applies to every channel.
- Adding a new channel means writing one adapter, not editing five dispatch sites and copy-pasting a lifecycle.
- The lifecycle can be tested once, against a fake sender, instead of three times through three live channels.

## User Stories

1. As an operator sending an email campaign, I want a mid-batch crash to resume without re-sending or losing recipients, so that large campaigns are reliable.
2. As an operator sending a WhatsApp campaign, I want the same crash-survival guarantee email already has, so that a crash mid-batch does not silently drop a batch's progress.
3. As an operator sending a personalised campaign, I want the same crash-survival guarantee, so that expensive AI-generated sends are not lost on a crash.
4. As an operator, I want a paused campaign to stop processing on every channel identically, so that pause behaves predictably.
5. As an operator, I want the recipient count of "sent" and "failed" to be accurate even if a batch is interrupted, so that I can trust campaign reporting.
6. As an operator running a WhatsApp campaign whose template is paused or misnamed, I want the campaign to halt after repeated permanent template errors rather than burn through the list, so that I do not waste sends.
7. As an operator, I want each channel's pacing between batches preserved (email's slower cadence and longer back-off after an error; WhatsApp's and personalised's cadence), so that provider rate limits are respected.
8. As a developer, I want one place that owns claiming a batch, flushing results, marking complete or failed, and scheduling the successor, so that I cannot introduce drift between channels.
9. As a developer adding a new channel, I want to implement one adapter behind a known interface, so that I do not have to touch the dispatch sites or re-derive the lifecycle.
10. As a developer fixing a batching, idempotency, or scheduling bug, I want one place to change and one place to test, so that the fix applies to every channel.
11. As a developer, I want the per-channel send logic (Graph `$batch`, the WhatsApp rate limiter, the tax/Claude personalisation) isolated behind the seam, so that I can test it without the lifecycle and test the lifecycle without it.
12. As a maintainer, I want the dead bulk-send paths removed, so that there is no second, divergent implementation of sending to maintain.
13. As a maintainer, I want the channel dispatch to be a single lookup rather than five copied conditionals, so that the worker entry point is unambiguous.
14. As a maintainer, I want a worker that loses the batch-claim race to behave the same on every channel, so that the worker pool stays stable regardless of channel.

## Implementation Decisions

**New module: Channel Send.** A single worker action becomes the only entry point for processing a queued batch. It reads the campaign's channel internally and selects a Channel Sender, so the five copied dispatch conditionals (in the queue, scheduled-kickoff, filter-processing, resume, and stuck-batch-recovery paths) collapse to scheduling one worker. The term enters the glossary (CONTEXT.md) as the canonical name, alongside **Channel Sender**, **Channel**, and **Batch**.

**The driver owns the batch lifecycle.** One driver owns: the paused-campaign check, fetching the next pending batch, claiming it with the idempotency guard, buffering and flushing per-recipient results, marking the batch complete, scheduling the successor, and marking the batch failed on a thrown error. The lost-claim-race behaviour is unified to one decided rule across channels.

**Channel Sender interface (push-based).** Each channel implements a single operation:

```
sendBatch(ctx, campaign, batch, emit: (results) => Promise<void>)
  : Promise<{ halt?: string; nextDelayMs?: number }>
```

The adapter runs only that channel's per-recipient send loop and its own side-effects, calling `emit` with results as it produces them. It returns an optional `halt` reason (which stops the driver scheduling a successor) and an optional `nextDelayMs` (the successor delay). This push-based shape is the decision that lets the driver — not the adapter — own crash-survival flushing, so the flush cadence is uniform across all channels.

**Adapters own their own side-effects.** The email adapter keeps Graph `$batch` chunking, the validate/prepare phase, the already-sent dedup, opportunity creation, and its deferred CRM-logging queue. The WhatsApp adapter keeps the rate limiter, header-media upload, Tina notification, inline CRM logging, and the three-strike permanent-template-error abort (surfaced as `halt`). The personalised adapter keeps its sequential tax-calculation and Claude generation. None of these are part of the seam.

**Flush cadence is the driver's.** `emit` appends results to the driver's buffer; the driver flushes every N (the existing interval of 25) and once more at the end, so partial progress survives a crash on every channel.

**Dead code removed.** The two bulk-send actions that reimplement the pipeline outside the queue are deleted; they are bound in the campaign-builder UI but never invoked.

**Phasing.** (0) delete the dead bulk-send actions; (1) extract a single dispatch helper and a shared batch-error handler so the five copied conditionals disappear with no behaviour change; (2) add characterization tests pinning current per-recipient output on the live path; (3) introduce the driver and the push-based Channel Sender interface and migrate one channel at a time (email, then WhatsApp, then personalised), leaving the others on the existing path until each is green. Each phase ships independently with the build and tests green.

**Out-of-band side-effect inconsistencies are preserved, not fixed.** Email logs CRM activity via a deferred background job; WhatsApp logs inline. This PRD preserves each channel's current behaviour (pinned by characterization tests). Reconciling CRM logging failure modes is a separate candidate.

## Testing Decisions

**What makes a good test here.** Tests assert externally observable behaviour at the seam: given a campaign, a batch, and a faked request boundary, the per-recipient results, the flush calls, and the `halt`/`nextDelayMs` outcomes are correct. Lifecycle tests assert what the driver does with a batch independent of channel. Tests target the interfaces, not private helpers.

**Modules tested.**

- Each Channel Sender is tested through `sendBatch` against a faked `ctx` and faked send boundary (the Graph client for email, `dynamicsRequest`/the WhatsApp send for the others): assert the produced per-recipient results, the `emit` calls, and the returned `halt`/`nextDelayMs`. The WhatsApp three-strike abort is asserted as a `halt`.
- The driver is tested once against a fake Channel Sender: assert claim → flush-every-N → mark-complete → reschedule-with-`nextDelayMs`, the `halt`-stops-scheduling path, the paused-campaign short-circuit, the lost-claim-race behaviour, and mark-failed-and-continue on a thrown error.
- Characterization tests pin each channel's current per-recipient output before migration so the refactor is provably behaviour-preserving.

**Prior art.** The repository already tests library logic against a faked request boundary (the Contact Query tests and the WhatsApp library tests under the Convex lib test directory). The Channel Send tests follow the same shape: a faked boundary plus assertions on observable results.

## Out of Scope

- Reconciling CRM logging failure modes across channels (separate candidate).
- The Campaign Lifecycle / status-transition module (separate candidate); this PRD keeps the existing status writes, moving only those the driver already performs.
- The new-campaign god-page cleanup (separate candidate).
- Changing batch sizes, provider rate limits, or pacing values beyond preserving current behaviour.
- Adding a new channel.

## Further Notes

- The deletion test confirms the module earns its keep: deleting the driver scatters the idempotency guard, the crash-survival flush, the self-scheduling-one-successor invariant, and mark-failed-and-continue back across three functions, where they have already drifted.
- Generalising crash-survival flushing to WhatsApp and personalised is a genuine behaviour change (a reliability fix), not a pure refactor — it is the point of choosing the push-based interface.
- The two bulk-send actions being dead code was confirmed in the campaign-builder page: they are bound via `useAction` but the live send path goes through `startCampaign` followed by the queue.
