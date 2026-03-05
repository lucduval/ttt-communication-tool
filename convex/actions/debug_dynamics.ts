"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { dynamicsRequest } from "../lib/dynamics_auth";
import { api } from "../_generated/api";

/**
 * Helper to inspect entity definitions
 */
export const inspectEntity = action({
    args: {
        entityName: v.string(),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        // Fetch entity definition to see attributes
        const endpoint = `EntityDefinitions(LogicalName='${args.entityName}')?$expand=Attributes`;
        return await dynamicsRequest(endpoint);
    },
});
