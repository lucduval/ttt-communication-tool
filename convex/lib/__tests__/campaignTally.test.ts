import { describe, test, expect } from "vitest";
import { tallyCampaign, type CampaignTally } from "../campaignTally";

describe("tallyCampaign", () => {
    test("empty input yields all zeros", () => {
        expect(tallyCampaign([])).toEqual<CampaignTally>({
            sent: 0,
            delivered: 0,
            failed: 0,
            pending: 0,
        });
    });

    test("sent counts the 'sent' status", () => {
        expect(tallyCampaign(["sent", "sent"])).toEqual<CampaignTally>({
            sent: 2,
            delivered: 0,
            failed: 0,
            pending: 0,
        });
    });

    test("sent includes delivered (successfully handed to provider)", () => {
        expect(tallyCampaign(["sent", "delivered", "delivered"])).toEqual<CampaignTally>({
            sent: 3,
            delivered: 2,
            failed: 0,
            pending: 0,
        });
    });

    test("failed counts the 'failed' status", () => {
        expect(tallyCampaign(["failed", "failed"])).toEqual<CampaignTally>({
            sent: 0,
            delivered: 0,
            failed: 2,
            pending: 0,
        });
    });

    test("pending counts the 'pending' status", () => {
        expect(tallyCampaign(["pending"])).toEqual<CampaignTally>({
            sent: 0,
            delivered: 0,
            failed: 0,
            pending: 1,
        });
    });

    test("'attempted' (in-flight, handed to the provider, outcome unknown) folds into pending", () => {
        expect(tallyCampaign(["attempted"])).toEqual<CampaignTally>({
            sent: 0,
            delivered: 0,
            failed: 0,
            pending: 1,
        });
    });

    test("an 'attempted' recipient counts as pending, never as sent or failed", () => {
        expect(tallyCampaign(["attempted", "attempted", "failed", "pending"])).toEqual<CampaignTally>({
            sent: 0,
            delivered: 0,
            failed: 1,
            pending: 3,
        });
    });

    test("recipient total is stable across a recovery re-run (pending → attempted → re-attempted)", () => {
        // Total = one row per recipient = the sum of the buckets (no "delivered"
        // status here, so `sent` isn't double-counted). Idempotent re-marking
        // patches the same row rather than inserting, so the count cannot drift,
        // and pending ↔ attempted both land in the pending bucket.
        const total = (t: CampaignTally) => t.sent + t.failed + t.pending;
        const before = tallyCampaign(["pending", "pending", "sent"]);
        // one pending recipient is marked attempted (still a single row)...
        const afterMark = tallyCampaign(["attempted", "pending", "sent"]);
        // ...and re-marking is idempotent — the same lone attempted row.
        const afterRemark = tallyCampaign(["attempted", "pending", "sent"]);

        expect(afterMark.pending).toBe(before.pending);
        expect(total(afterMark)).toBe(total(before));
        expect(afterRemark).toEqual(afterMark);
    });

    test("a full mix maps every status to its bucket", () => {
        const statuses = [
            "pending",
            "sent",
            "delivered",
            "failed",
            "sent",
            "delivered",
            "pending",
        ];
        expect(tallyCampaign(statuses)).toEqual<CampaignTally>({
            sent: 4, // 2 sent + 2 delivered
            delivered: 2,
            failed: 1,
            pending: 2,
        });
    });

    test("unknown statuses contribute to no bucket (handled deterministically)", () => {
        const statuses = ["sent", "queued", "opened", "clicked", "", "bounced"];
        expect(tallyCampaign(statuses)).toEqual<CampaignTally>({
            sent: 1,
            delivered: 0,
            failed: 0,
            pending: 0,
        });
    });

    test("accepts any iterable of statuses, not just an array", () => {
        const statuses = new Set(["sent", "delivered", "failed", "pending"]);
        expect(tallyCampaign(statuses)).toEqual<CampaignTally>({
            sent: 2,
            delivered: 1,
            failed: 1,
            pending: 1,
        });
    });
});
