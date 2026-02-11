import { v } from "convex/values";
import { mutation, query, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";

// Helper for admin check
export async function checkAdminAccess(ctx: QueryCtx | MutationCtx) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();

    if (!user || user.status !== "active" || user.role !== "admin") {
        return null;
    }
    return identity;
}

// Helper for general access check
export async function checkAccessHelper(ctx: QueryCtx | MutationCtx) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { hasAccess: false };

    const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();

    if (!user) {
        // Check by email fallback?
        if (identity.email) {
            const userByEmail = await ctx.db
                .query("users")
                .withIndex("by_email", (q) => q.eq("email", identity.email!))
                .first();
            if (userByEmail && userByEmail.status === 'active') return { hasAccess: true, user: userByEmail };
        }
        return { hasAccess: false };
    }

    return {
        hasAccess: user.status === "active",
        user: user
    };
}

/**
 * Store user data from Clerk webhook or on login
 * Checks if user is invited or already exists
 */
export const store = mutation({
    args: {
        clerkId: v.string(),
        email: v.string(),
        name: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        // Check if user already exists
        const existingUser = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
            .first();

        if (existingUser) {
            // Update last login
            await ctx.db.patch(existingUser._id, {
                lastLoginAt: Date.now(),
                name: args.name || existingUser.name,
            });
            return existingUser;
        }

        // Check if there is an existing record with this email (pre-invited)
        const invitedUser = await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", args.email))
            .first();

        if (invitedUser) {
            // Link Clerk ID to existing user record
            await ctx.db.patch(invitedUser._id, {
                clerkId: args.clerkId,
                name: args.name || invitedUser.name,
                lastLoginAt: Date.now(),
                status: "active", // Activate if it was pending
            });
            return invitedUser;
        }

        // New user signing up without pre-invite? 
        // For now we store them but as 'inactive' until approved or if we want to allow auto-provisioning
        // Based on requirements "Only specific users should access", so we default to inactive or throw/don't create?
        // Let's create as inactive so we have a record, admin can approve.

        // HOWEVER, if we want strict access:
        // We could return null or throw. 
        // Plan says "Only specific users... Invited users become part of org".
        // So if not invited, they shouldn't access.
        // We'll create a record with 'pending_approval' or just 'inactive' status.

        // For simplicity, let's create them but checkAccess will fail.

        const userId = await ctx.db.insert("users", {
            clerkId: args.clerkId,
            email: args.email,
            name: args.name,
            role: "user", // Default role
            status: "inactive",
            joinedAt: Date.now(),
            lastLoginAt: Date.now(),
        });

        return await ctx.db.get(userId);
    },
});

/**
 * Check if the current user has access
 */
export const checkAccess = query({
    args: {},
    handler: async (ctx) => {
        return await checkAccessHelper(ctx);
    },
});

/**
 * Admin: List all users
 */
export const list = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        return await ctx.db.query("users").collect();
    }
});

/**
 * Admin: List all invitations
 */
export const listInvitations = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        return await ctx.db.query("invitations").order("desc").collect();
    }
});

/**
 * Admin: Invite a user
 */
export const createInvitation = mutation({
    args: {
        email: v.string(),
        role: v.union(v.literal("admin"), v.literal("user")),
    },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");
        const adminUser = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", (q) => q.eq("clerkId", access.subject))
            .first();

        if (!adminUser) throw new Error("Admin user not found");

        // Check if user already exists
        const existingUser = await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", args.email))
            .first();

        if (existingUser) {
            // If inactive, reactivate?
            if (existingUser.status === "inactive") {
                await ctx.db.patch(existingUser._id, { status: "active", role: args.role, invitedBy: adminUser._id });
                return { status: "reactivated" };
            }
            throw new Error("User already exists");
        }

        // Check pending invitations
        const existingInvite = await ctx.db
            .query("invitations")
            .withIndex("by_email", (q) => q.eq("email", args.email))
            .filter(q => q.eq(q.field("status"), "pending"))
            .first();

        if (existingInvite) throw new Error("Invitation already pending");

        // Create token
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days

        await ctx.db.insert("invitations", {
            email: args.email,
            token,
            role: args.role,
            invitedBy: adminUser._id,
            status: "pending",
            expiresAt,
        });

        // Create the user record as authorized 'pre-signup' user
        await ctx.db.insert("users", {
            email: args.email,
            role: args.role,
            status: "active", // Active because they are allowed, they just need to sign up
            invitedBy: adminUser._id,
            joinedAt: Date.now(),
        });

        // Logic to send email would go here (using internal action)

        return { token };
    }
});

/**
 * Admin: Revoke invitation
 */
export const revokeInvitation = mutation({
    args: { id: v.id("invitations") },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        await ctx.db.patch(args.id, { status: "revoked" });
    }
});

/**
 * Admin: Update user role/status
 */
export const updateUser = mutation({
    args: {
        id: v.id("users"),
        role: v.optional(v.union(v.literal("admin"), v.literal("user"))),
        status: v.optional(v.string())
    },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        const updates: any = {};
        if (args.role) updates.role = args.role;
        if (args.status) updates.status = args.status;

        await ctx.db.patch(args.id, updates);
    }
});


