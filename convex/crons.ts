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

// Recover batches stuck in "processing" state (e.g. after action crash/timeout)
crons.interval(
    "recover-stuck-batches",
    { minutes: 5 },
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
