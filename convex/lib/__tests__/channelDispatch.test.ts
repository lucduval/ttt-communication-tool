/**
 * Unit tests for the single channel-dispatch helper and the shared batch-error
 * handler (issue #11). These collapse the three-way channel conditional that was
 * copy-pasted across five call sites (queue, scheduled-kickoff, filter-processing,
 * resume, stuck-batch-recovery) into one lookup, and the per-channel catch blocks
 * into one error handler.
 */
import { describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { batchProcessorFor, handleBatchError } from "../channelDispatch";

describe("batchProcessorFor", () => {
    it("maps each channel to its batch-processing worker", () => {
        expect(getFunctionName(batchProcessorFor("email"))).toBe(
            "campaignQueue:processEmailBatch"
        );
        expect(getFunctionName(batchProcessorFor("whatsapp"))).toBe(
            "campaignQueue:processWhatsAppBatch"
        );
        expect(getFunctionName(batchProcessorFor("personalised"))).toBe(
            "campaignQueue:processPersonalisedBatch"
        );
    });
});

function createCtx(hasMoreBatches: boolean) {
    const mutations: Array<{ name: string; args: any }> = [];
    const scheduled: Array<{ ms: number; name: string }> = [];
    const ctx = {
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            mutations.push({ name: getFunctionName(ref as any), args });
            return { hasMoreBatches };
        }),
        scheduler: {
            runAfter: vi.fn(async (ms: number, ref: unknown) => {
                scheduled.push({ ms, name: getFunctionName(ref as any) });
            }),
        },
    };
    return { ctx, mutations, scheduled };
}

describe("handleBatchError", () => {
    it("marks the batch failed and reschedules the same channel when batches remain", async () => {
        const { ctx, mutations, scheduled } = createCtx(true);

        await handleBatchError(ctx as any, {
            channel: "whatsapp",
            campaignId: "c1" as any,
            batchId: "b1" as any,
            err: new Error("boom"),
            retryDelayMs: 500,
        });

        expect(mutations).toEqual([
            {
                name: "campaignBatches:markBatchFailed",
                args: { batchId: "b1", errorMessage: "boom" },
            },
        ]);
        expect(scheduled).toEqual([
            { ms: 500, name: "campaignQueue:processWhatsAppBatch" },
        ]);
    });

    it("does not reschedule when no batches remain", async () => {
        const { ctx, scheduled } = createCtx(false);

        await handleBatchError(ctx as any, {
            channel: "email",
            campaignId: "c1" as any,
            batchId: "b1" as any,
            err: new Error("boom"),
            retryDelayMs: 10000,
        });

        expect(scheduled).toEqual([]);
    });

    it("uses the given retry delay and the matching channel worker", async () => {
        const { ctx, scheduled } = createCtx(true);

        await handleBatchError(ctx as any, {
            channel: "email",
            campaignId: "c1" as any,
            batchId: "b1" as any,
            err: new Error("boom"),
            retryDelayMs: 10000,
        });

        expect(scheduled).toEqual([
            { ms: 10000, name: "campaignQueue:processEmailBatch" },
        ]);
    });

    it("falls back to 'Unknown error' for non-Error throwables", async () => {
        const { ctx, mutations } = createCtx(false);

        await handleBatchError(ctx as any, {
            channel: "personalised",
            campaignId: "c1" as any,
            batchId: "b1" as any,
            err: "a string",
            retryDelayMs: 500,
        });

        expect(mutations[0].args.errorMessage).toBe("Unknown error");
    });
});
