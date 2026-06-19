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
