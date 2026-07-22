/**
 * Managed disclaimer collection tests (PRD #74, issue #76) — faked `ctx`.
 *
 * These pin the load-bearing behaviour of the disclaimers module: the operator
 * list excludes archived disclaimers, but an archived disclaimer stays resolvable
 * by id so historical campaigns remain meaningful. They drive the exported `*Impl`
 * functions against an in-memory faked Convex `ctx` (same style as startCampaignImpl).
 */
import { describe, it, expect } from "vitest";
import {
    listImpl,
    getByIdImpl,
    createImpl,
    updateImpl,
    archiveImpl,
} from "../disclaimers";

// In-memory ctx supporting what checkAccessHelper needs (users by_clerk_id) plus
// the disclaimers table operations the module uses.
function makeCtx({ role = "admin" as "admin" | "user" } = {}) {
    const user = {
        _id: "user-admin",
        clerkId: "clerk-1",
        email: "admin@ttt.io",
        status: "active",
        role,
    };
    const users = [user];
    const disclaimers: any[] = [];
    let seq = 0;

    const builder = (rows: any[]) => {
        let filtered = [...rows];
        const b: any = {
            withIndex: (_name: string, fn?: any) => {
                if (fn) {
                    const q = {
                        eq: (field: string, value: any) => {
                            filtered = filtered.filter((r) => r[field] === value);
                            return q;
                        },
                    };
                    fn(q);
                }
                return b;
            },
            order: () => b,
            collect: async () => filtered,
            first: async () => filtered[0] ?? null,
        };
        return b;
    };

    const ctx = {
        auth: {
            getUserIdentity: async () => ({ subject: "clerk-1", email: "admin@ttt.io" }),
        },
        db: {
            query: (table: string) => builder(table === "users" ? users : disclaimers),
            get: async (id: string) => disclaimers.find((d) => d._id === id) ?? null,
            insert: async (_table: string, doc: any) => {
                const _id = `disclaimers-${seq++}`;
                disclaimers.push({ _id, ...doc });
                return _id;
            },
            patch: async (id: string, updates: any) => {
                const row = disclaimers.find((d) => d._id === id);
                Object.assign(row, updates);
            },
        },
    };

    return { ctx, disclaimers, user };
}

describe("disclaimers module", () => {
    it("create inserts a disclaimer owned by the current user", async () => {
        const { ctx, user } = makeCtx();

        const id = await createImpl(ctx, { name: "Standard", htmlContent: "<p>x</p>" });

        const created = await getByIdImpl(ctx, { id });
        expect(created.name).toBe("Standard");
        expect(created.htmlContent).toBe("<p>x</p>");
        expect(created.createdBy).toBe(user._id);
        expect(created.archived).toBeUndefined();
    });

    it("update edits an existing disclaimer's fields", async () => {
        const { ctx } = makeCtx();
        const id = await createImpl(ctx, { name: "Standard", htmlContent: "<p>old</p>" });

        await updateImpl(ctx, { id, htmlContent: "<p>new</p>" });

        const updated = await getByIdImpl(ctx, { id });
        expect(updated.htmlContent).toBe("<p>new</p>");
        expect(updated.name).toBe("Standard");
    });

    it("list returns active disclaimers and excludes archived ones", async () => {
        const { ctx } = makeCtx();
        const activeId = await createImpl(ctx, { name: "Active", htmlContent: "<p>a</p>" });
        const archivedId = await createImpl(ctx, { name: "Old", htmlContent: "<p>o</p>" });

        await archiveImpl(ctx, { id: archivedId });

        const listed = await listImpl(ctx);
        const ids = listed.map((d: any) => d._id);
        expect(ids).toContain(activeId);
        expect(ids).not.toContain(archivedId);
    });

    it("archive sets a flag rather than hard-deleting; the row stays resolvable by id", async () => {
        const { ctx } = makeCtx();
        const id = await createImpl(ctx, { name: "Old", htmlContent: "<p>o</p>" });

        await archiveImpl(ctx, { id });

        // Excluded from the operator list...
        const listed = await listImpl(ctx);
        expect(listed.map((d: any) => d._id)).not.toContain(id);

        // ...but still resolvable by id for historical campaigns.
        const resolved = await getByIdImpl(ctx, { id });
        expect(resolved).not.toBeNull();
        expect(resolved.archived).toBe(true);
        expect(resolved.name).toBe("Old");
    });
});
