import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Bootstrap the first admin user
 * Call this via CLI: npx convex run admin:bootstrapAdmin --args '{ "email": "your-email@example.com" }'
 */
export const bootstrapAdmin = internalMutation({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", args.email))
            .first();

        if (!user) {
            // Create if not exists (seed)
            await ctx.db.insert("users", {
                email: args.email,
                role: "admin",
                status: "active",
                joinedAt: Date.now(),
            });
            console.log(`Created new admin user: ${args.email}`);
            return "Created new admin user";
        }

        // Promote existing
        await ctx.db.patch(user._id, {
            role: "admin",
            status: "active",
        });
        console.log(`Promoted user to admin: ${args.email}`);
        return "Promoted user to admin";
    }
});
