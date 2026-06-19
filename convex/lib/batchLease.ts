/**
 * Batch Lease — the pure campaign-liveness predicate (PRD #39, slice #40).
 *
 * A campaign send is processed batch-by-batch by a worker action. If a worker
 * dies mid-send (crash, Convex action timeout, deploy) its batch would sit in
 * `processing` forever and the campaign silently stalls. The lease makes that
 * detectable: a worker beats periodically, and a batch whose last beat is older
 * than `LEASE_MS` while still `processing` is considered dead and reclaimable.
 *
 * This module is pure — no Convex/DB imports — and takes `now` as an argument
 * so it can be unit-tested as a truth table. Nothing is wired to it yet.
 */

/** Minimum gap between heartbeat DB writes from a single worker (~30s). */
export const HEARTBEAT_THROTTLE_MS = 30_000;

/**
 * A batch is considered dead if its worker has not beaten within this window
 * (~3 min). Sized ≈ 6 × HEARTBEAT_THROTTLE_MS so a healthy worker that emits
 * any results keeps its lease comfortably, while a dead worker is reaped well
 * inside Convex's ~10-min action limit.
 */
export const LEASE_MS = 6 * HEARTBEAT_THROTTLE_MS;

/** The subset of a campaignBatches row the lease predicate reads. */
export interface LeasedBatch {
    status: string;
    heartbeatAt?: number;
    startedAt?: number;
}

/**
 * Last time of life for a batch: its latest heartbeat, or the claim time for a
 * pre-heartbeat batch, or 0 if it has never been claimed.
 */
export function lastBeat(batch: LeasedBatch): number {
    return batch.heartbeatAt ?? batch.startedAt ?? 0;
}

/** A `processing` batch whose last beat is older than the lease window is dead. */
export function isDead(batch: LeasedBatch, now: number): boolean {
    return batch.status === "processing" && now - lastBeat(batch) > LEASE_MS;
}

/** Whether enough time has passed since the last heartbeat write to beat again. */
export function shouldBeat(lastWriteAt: number, now: number): boolean {
    return now - lastWriteAt >= HEARTBEAT_THROTTLE_MS;
}
