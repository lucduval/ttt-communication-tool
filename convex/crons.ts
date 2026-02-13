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

export default crons;
