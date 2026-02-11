import { query } from "./_generated/server";
import { v } from "convex/values";

export const getDashboardStats = query({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const startOfMonthMs = startOfMonth.getTime();

        const startOf14DaysAgo = new Date();
        startOf14DaysAgo.setDate(startOf14DaysAgo.getDate() - 14);
        startOf14DaysAgo.setHours(0, 0, 0, 0);
        const startOf14DaysAgoMs = startOf14DaysAgo.getTime();

        const campaigns = await ctx.db.query("campaigns").order("desc").collect();

        let sentThisMonth = 0;
        let totalDelivered = 0;
        let totalSent = 0;
        let totalFailedMessages = 0;

        // For Trends
        // key: "YYYY-MM-DD", value: count
        const dailySent: Record<string, number> = {};
        // Initialize last 14 days with 0
        for (let i = 0; i < 14; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dailySent[dateStr] = 0;
        }

        const activeCampaigns = [];

        for (const campaign of campaigns) {
            const createdTime = campaign._creationTime;

            // Sent this Month
            if (createdTime >= startOfMonthMs) {
                sentThisMonth += (campaign.sentCount || 0);
            }

            // Global Stats for Avg Delivery Rate
            totalDelivered += (campaign.deliveredCount || 0);
            totalSent += (campaign.sentCount || 0);

            // Sum failed messages across all campaigns
            totalFailedMessages += (campaign.failedCount || 0);

            // Active Campaigns (processing or queued)
            // Also include recently created drafts? No, usually running.
            if (campaign.status === "processing" || campaign.status === "queued") {
                activeCampaigns.push(campaign);
            }

            // Trends (Last 14 days)
            if (createdTime >= startOf14DaysAgoMs) {
                const dateStr = new Date(createdTime).toISOString().split('T')[0];
                if (dailySent[dateStr] !== undefined) {
                    dailySent[dateStr] += (campaign.sentCount || 0);
                }
            }
        }

        // Avg Delivery Rate
        let avgDeliveryRate = 0;
        if (totalSent > 0) {
            avgDeliveryRate = (totalDelivered / totalSent) * 100;
        }

        // Format trends for recharts or UI
        // Ensure chronological order
        const trends = Object.entries(dailySent)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));

        // Recent campaigns (last 10, any status) for campaign history
        const recentCampaigns = campaigns.slice(0, 10).map((c) => ({
            _id: c._id,
            name: c.name,
            channel: c.channel,
            status: c.status,
            sentCount: c.sentCount || 0,
            failedCount: c.failedCount || 0,
            totalRecipients: c.totalRecipients,
            _creationTime: c._creationTime,
        }));

        return {
            sentThisMonth,
            avgDeliveryRate: Math.round(avgDeliveryRate),
            totalFailedMessages,
            totalCampaigns: campaigns.length,
            trends,
            activeCampaigns: activeCampaigns.slice(0, 5),
            recentCampaigns,
        };
    },
});
