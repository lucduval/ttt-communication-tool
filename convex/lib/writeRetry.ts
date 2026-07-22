/**
 * Reactive backoff for Convex's deployment-wide write-rate ceiling.
 *
 * Convex limits a deployment to ~4 MiB/s of writes and surfaces a breach as a
 * `TooManyWrites` error. Every write the send pipeline issues — batch claim,
 * `attempted` marker, per-recipient status flush, batch complete, heartbeat, the
 * mark-failed on the error path, and the click/open tracking writes hit by an
 * inbound pixel/redirect — competes for that one ceiling. When concurrent
 * workers and webhooks saturate it, ANY of those writes can trip `TooManyWrites`,
 * not just the busiest one.
 *
 * `withWriteRetry` pauses a growing interval and retries the SAME write on a
 * breach. That both (a) lets a transient rate-limit window pass so a campaign
 * does not lose a batch (or an open/click), and (b) reactively paces aggregate
 * throughput: each writer backs off under contention, spreading writes out
 * instead of all hammering the wall at once. A non-rate-limit error, or an
 * exhausted retry budget, propagates unchanged so the caller's error handling
 * still runs. Defaults (5 retries, 250 ms base → ~7.75 s worst case) stay well
 * inside Convex's ~10-min action limit.
 */

export const WRITE_RETRY_MAX_RETRIES = 5;
export const WRITE_RETRY_BACKOFF_BASE_MS = 250;

/** Convex surfaces the deployment write-rate breach as a `TooManyWrites` error. */
export function isTooManyWrites(err: unknown): boolean {
    return err instanceof Error && /too\s*many\s*writes/i.test(err.message);
}

export async function withWriteRetry<T>(
    fn: () => Promise<T>,
    sleep: (ms: number) => Promise<void>,
    maxRetries: number = WRITE_RETRY_MAX_RETRIES,
    baseMs: number = WRITE_RETRY_BACKOFF_BASE_MS
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isTooManyWrites(err) || attempt >= maxRetries) throw err;
            await sleep(baseMs * 2 ** attempt);
        }
    }
}
