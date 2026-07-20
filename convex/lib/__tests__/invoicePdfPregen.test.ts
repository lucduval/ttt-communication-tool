/**
 * Invoice-PDF pre-generation orchestrator tests (PRD
 * `prd-bad-debt-excel-campaign.md`, #68).
 *
 * The orchestrator is pure and dependency-injected, so these tests mock the Azure
 * client (`fetchPdf`) and Convex storage (`store`) and assert the external
 * behaviour at the seam: a `storageId` recorded per generated recipient, a failure
 * recorded per failed one (whether the client or storage was the failing edge), and
 * — the load-bearing guardrail — never more than `concurrency` fetches in flight.
 */
import { describe, it, expect, vi } from "vitest";
import {
    pregenInvoicePdfs,
    type PregenItem,
    type PregenOutcome,
    type PregenDeps,
} from "../invoicePdfPregen";

function items(n: number): PregenItem[] {
    return Array.from({ length: n }, (_, i) => ({
        recipientId: `r${i}`,
        invoiceGuid: `guid-${i}`,
    }));
}

/** A recording `record` dep plus the list of outcomes it saw. */
function recorder() {
    const recorded: PregenOutcome[] = [];
    const record: PregenDeps["record"] = async (o) => {
        recorded.push(o);
    };
    return { recorded, record };
}

describe("pregenInvoicePdfs", () => {
    it("records a storageId for each generated recipient", async () => {
        const { recorded, record } = recorder();
        const summary = await pregenInvoicePdfs(items(3), {
            concurrency: 2,
            fetchPdf: async () => new ArrayBuffer(8),
            store: async (_bytes, item) => `storage-${item.recipientId}`,
            record,
        });

        expect(summary).toEqual({ total: 3, generated: 3, failed: 0 });
        expect(recorded).toHaveLength(3);
        for (const o of recorded) {
            expect(o.status).toBe("generated");
            if (o.status !== "generated") throw new Error("unreachable");
            expect(o.storageId).toBe(`storage-${o.recipientId}`);
        }
    });

    it("records a failure (never a storageId) when the client fetch throws", async () => {
        const { recorded, record } = recorder();
        const store = vi.fn(async () => "unused");
        const summary = await pregenInvoicePdfs([{ recipientId: "r0", invoiceGuid: "g0" }], {
            concurrency: 1,
            fetchPdf: async () => {
                throw new Error("400 bad invoiceId");
            },
            store,
            record,
        });

        expect(summary).toEqual({ total: 1, generated: 0, failed: 1 });
        expect(store).not.toHaveBeenCalled();
        expect(recorded[0].status).toBe("failed");
        if (recorded[0].status !== "failed") throw new Error("unreachable");
        expect(recorded[0].error).toContain("400");
    });

    it("records a failure when storage store throws (bytes fetched but not stored)", async () => {
        const { recorded, record } = recorder();
        const summary = await pregenInvoicePdfs([{ recipientId: "r0", invoiceGuid: "g0" }], {
            concurrency: 1,
            fetchPdf: async () => new ArrayBuffer(4),
            store: async () => {
                throw new Error("storage full");
            },
            record,
        });

        expect(summary).toEqual({ total: 1, generated: 0, failed: 1 });
        expect(recorded[0].status).toBe("failed");
    });

    it("mixes generated + failed and counts both", async () => {
        const { recorded, record } = recorder();
        const summary = await pregenInvoicePdfs(items(4), {
            concurrency: 4,
            // Even recipients succeed; odd ones fail.
            fetchPdf: async (item) => {
                if (item.recipientId.endsWith("1") || item.recipientId.endsWith("3")) {
                    throw new Error("nope");
                }
                return new ArrayBuffer(1);
            },
            store: async (_b, item) => `s-${item.recipientId}`,
            record,
        });

        expect(summary).toEqual({ total: 4, generated: 2, failed: 2 });
        expect(recorded.filter((o) => o.status === "generated")).toHaveLength(2);
        expect(recorded.filter((o) => o.status === "failed")).toHaveLength(2);
    });

    it("never runs more than `concurrency` fetches in flight", async () => {
        const concurrency = 3;
        let inFlight = 0;
        let maxInFlight = 0;
        const { record } = recorder();

        await pregenInvoicePdfs(items(12), {
            concurrency,
            fetchPdf: async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                // Yield so all slots fill before any completes — forces real overlap.
                await new Promise((r) => setTimeout(r, 2));
                inFlight--;
                return new ArrayBuffer(1);
            },
            store: async () => "s",
            record,
        });

        expect(maxInFlight).toBe(concurrency);
    });

    it("is a no-op for an empty item list", async () => {
        const fetchPdf = vi.fn();
        const summary = await pregenInvoicePdfs([], {
            concurrency: 5,
            fetchPdf: fetchPdf as unknown as PregenDeps["fetchPdf"],
            store: async () => "s",
            record: async () => {},
        });
        expect(summary).toEqual({ total: 0, generated: 0, failed: 0 });
        expect(fetchPdf).not.toHaveBeenCalled();
    });
});
