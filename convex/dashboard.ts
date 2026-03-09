import { query } from "./_generated/server";
import { checkAccessHelper } from "./users";

export const getDashboardStats = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const isAdmin = access.user.role === "admin";
        const clerkId = access.user.clerkId;

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const startOfMonthMs = startOfMonth.getTime();

        const startOf14DaysAgo = new Date();
        startOf14DaysAgo.setDate(startOf14DaysAgo.getDate() - 14);
        startOf14DaysAgo.setHours(0, 0, 0, 0);
        const startOf14DaysAgoMs = startOf14DaysAgo.getTime();

        // Admins see all campaigns; regular users only see their own
        const campaigns = isAdmin
            ? await ctx.db.query("campaigns").order("desc").collect()
            : await ctx.db
                .query("campaigns")
                .withIndex("by_user", (q) => q.eq("createdBy", clerkId!))
                .order("desc")
                .collect();

        let sentThisMonth = 0;
        let totalDelivered = 0;
        let totalSent = 0;
        let totalFailedMessages = 0;

        const dailySent: Record<string, number> = {};
        for (let i = 0; i < 14; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dailySent[dateStr] = 0;
        }

        for (const campaign of campaigns) {
            const createdTime = campaign._creationTime;

            if (createdTime >= startOfMonthMs) {
                sentThisMonth += (campaign.sentCount || 0);
            }

            totalDelivered += (campaign.deliveredCount || 0);
            totalSent += (campaign.sentCount || 0);
            totalFailedMessages += (campaign.failedCount || 0);

            if (createdTime >= startOf14DaysAgoMs) {
                const dateStr = new Date(createdTime).toISOString().split('T')[0];
                if (dailySent[dateStr] !== undefined) {
                    dailySent[dateStr] += (campaign.sentCount || 0);
                }
            }
        }

        const avgDeliveryRate = totalSent > 0
            ? Math.round((totalDelivered / totalSent) * 100)
            : 0;

        const trends = Object.entries(dailySent)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));

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
            avgDeliveryRate,
            totalFailedMessages,
            totalCampaigns: campaigns.length,
            trends,
            recentCampaigns,
            isAdmin,
        };
    },
});
