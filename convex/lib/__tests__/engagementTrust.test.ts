import { describe, test, expect } from "vitest";
import {
    assessEngagement,
    DEFAULT_TRUST_POLICY,
    type EngagementEvidence,
} from "../engagementTrust";

const MIN = 60_000;

describe("assessEngagement (default policy: corroboration required, 2m prefetch window)", () => {
    test("no engagement at all → none", () => {
        const r = assessEngagement({ hasOpen: false, hasClick: false });
        expect(r.verdict).toBe("none");
        expect(r.suspectClick).toBe(false);
    });

    test("open only, human latency → warm", () => {
        const r = assessEngagement({ hasOpen: true, hasClick: false, openLatencyMs: 30 * MIN });
        expect(r.verdict).toBe("warm");
        expect(r.trustedOpen).toBe(true);
    });

    test("click corroborated by an open, human latency → hot", () => {
        const r = assessEngagement({
            hasOpen: true,
            hasClick: true,
            openLatencyMs: 10 * MIN,
            clickLatencyMs: 12 * MIN,
        });
        expect(r.verdict).toBe("hot");
        expect(r.trustedClick).toBe(true);
        expect(r.suspectClick).toBe(false);
    });

    // The reported failure mode: HOT label with no open behind it.
    test("click with NO open → not hot, flagged suspect", () => {
        const r = assessEngagement({ hasOpen: false, hasClick: true, clickLatencyMs: 30 * MIN });
        expect(r.verdict).toBe("none");
        expect(r.suspectClick).toBe(true);
        expect(r.reasons).toContain("click with no corresponding open");
    });

    // Delivery-time link scanning: click lands seconds after send.
    test("click within prefetch window → not hot, flagged suspect", () => {
        const r = assessEngagement({
            hasOpen: true,
            hasClick: true,
            openLatencyMs: 5_000,
            clickLatencyMs: 5_000,
        });
        expect(r.trustedClick).toBe(false);
        expect(r.suspectClick).toBe(true);
        expect(r.reasons).toContain("click within prefetch window of send");
    });

    test("a prefetched click still earns warm if a later human open corroborates", () => {
        const r = assessEngagement({
            hasOpen: true,
            hasClick: true,
            openLatencyMs: 40 * MIN, // human opened later
            clickLatencyMs: 3_000, // gateway prefetch at send
        });
        // click is not trusted (prefetch), but the open is human → warm, not hot
        expect(r.verdict).toBe("warm");
        expect(r.suspectClick).toBe(true);
    });

    test("missing latency is not treated as prefetch (unknown ≠ instant)", () => {
        const r = assessEngagement({ hasOpen: true, hasClick: true }); // no sentAt → no latency
        expect(r.verdict).toBe("hot");
    });
});

describe("policy knobs", () => {
    test("requireOpenForClickTrust=false trusts a human-latency click without an open", () => {
        const r = assessEngagement(
            { hasOpen: false, hasClick: true, clickLatencyMs: 30 * MIN },
            { ...DEFAULT_TRUST_POLICY, requireOpenForClickTrust: false }
        );
        expect(r.verdict).toBe("hot");
    });

    test("a wider prefetch window reclassifies a borderline click as scanner", () => {
        const ev: EngagementEvidence = {
            hasOpen: true,
            hasClick: true,
            openLatencyMs: 40 * MIN, // open is unambiguously human
            clickLatencyMs: 8 * MIN, // click is borderline
        };
        expect(assessEngagement(ev).verdict).toBe("hot"); // 8m > default 2m window
        expect(
            assessEngagement(ev, { ...DEFAULT_TRUST_POLICY, prefetchWindowMs: 10 * MIN }).verdict
        ).toBe("warm");
    });
});
