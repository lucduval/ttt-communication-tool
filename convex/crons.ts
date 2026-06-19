import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Process bounced emails every hour
crons.interval(
    "process-bounces",
    { hours: 1 },
    internal.bounces.processBounces,
    { limit: 50 }
);

// Recover batches stuck in "processing" state (e.g. after action crash/timeout).
// Runs every minute so recovery latency ≈ cron interval + lease (~2–3 min) once a
// worker dies, instead of the old ~25 min. The heartbeat-aware `isDead` reap keeps
// a slow-but-alive worker from being falsely revived at this faster cadence.
crons.interval(
    "recover-stuck-batches",
    { minutes: 1 },
    internal.campaignBatches.recoverStuckBatches,
    {}
);

// Mark unengaged opportunities as Cold after 30 days of no opens or clicks
crons.daily(
    "mark-cold-opportunities",
    { hourUTC: 2, minuteUTC: 0 },
    internal.opportunities.markStaleOpportunitiesCold,
    {}
);

export default crons;
