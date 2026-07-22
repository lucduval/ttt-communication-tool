/**
 * Byte-aware send pacing — pure core.
 *
 * Microsoft Graph throttles outbound mail on an **IncomingBytes** budget (bytes
 * accepted per rolling window), surfaced as a 429 "ApplicationThrottled —
 * Application is over its IncomingBytes limit". Because the ceiling is bytes, not
 * message count, the email sender paces each Graph `$batch` chunk by the bytes it
 * actually puts on the wire rather than by a fixed per-batch delay: a chunk of
 * tiny text emails waits milliseconds, a chunk of heavy HTML/attachment emails
 * waits proportionally longer, so throughput self-tunes to the payload.
 *
 * Kept pure (no `ctx`, no timers) so the rate arithmetic is unit-tested in
 * isolation; the sender owns reading the env config and doing the actual sleep.
 */

/** Default target throughput (bytes/sec), set below Graph's ceiling for headroom. */
export const DEFAULT_TARGET_BYTES_PER_SEC = 300_000;

/** Default cap on a single pause so one very large chunk can't stall the action. */
export const DEFAULT_MAX_PACE_MS = 60_000;

/**
 * The delay to wait after sending a chunk of `chunkBytes` so the rolling send
 * rate stays at/under `targetBytesPerSec`, capped at `maxPaceMs`. Returns 0 for a
 * non-positive byte count. Guards a non-positive target by falling back to the
 * default so a mis-set env var can never divide by zero or send unpaced.
 */
export function computeSendPaceMs(
    chunkBytes: number,
    targetBytesPerSec: number = DEFAULT_TARGET_BYTES_PER_SEC,
    maxPaceMs: number = DEFAULT_MAX_PACE_MS
): number {
    if (chunkBytes <= 0) return 0;
    const target = targetBytesPerSec > 0 ? targetBytesPerSec : DEFAULT_TARGET_BYTES_PER_SEC;
    const cap = Math.max(0, maxPaceMs);
    return Math.min(cap, Math.round((chunkBytes / target) * 1000));
}
