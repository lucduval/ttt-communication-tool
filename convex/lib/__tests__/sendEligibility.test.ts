/**
 * Send-path eligibility rule tests (PRD #55, slice #56).
 *
 * The eligibility rule is the core of the at-most-once idempotency seam: a
 * recipient is eligible to send iff it has NO `messages` row for the campaign,
 * in ANY status. It is pure — no Convex ctx, no DB — so no-duplicate behaviour
 * is provable as a truth table without a live mailbox. These tests mirror the
 * pure-function style of campaignTally.test.ts.
 */
import { describe, test, expect } from "vitest";
import {
    eligibleRecipients,
    MESSAGE_STATUSES,
    type ExistingMessage,
} from "../sendEligibility";

const recipients = [
    { id: "r1", name: "Alice" },
    { id: "r2", name: "Bob" },
    { id: "r3", name: "Carol" },
];

describe("eligibleRecipients", () => {
    test("with no existing rows, every recipient is eligible", () => {
        expect(eligibleRecipients([], recipients)).toEqual(recipients);
    });

    test("an empty batch yields no eligible recipients regardless of existing rows", () => {
        const rows: ExistingMessage[] = [{ recipientId: "r1", status: "sent" }];
        expect(eligibleRecipients(rows, [])).toEqual([]);
    });

    test("a recipient with a row in ANY status is treated as already-handled and skipped", () => {
        // The whole point of the rule: every recognised status — including the
        // new `attempted` marker and a terminal `failed` — means "already
        // handled". One recipient carries a row of each status in turn; it must
        // never be eligible.
        for (const status of MESSAGE_STATUSES) {
            const rows: ExistingMessage[] = [{ recipientId: "r2", status }];
            expect(eligibleRecipients(rows, recipients)).toEqual([
                { id: "r1", name: "Alice" },
                { id: "r3", name: "Carol" },
            ]);
        }
    });

    test("a `failed` recipient is now skipped (the headline behaviour change)", () => {
        // Previously the sent/delivered-only guard re-sent a `failed` recipient
        // on a recovery re-run; under the eligibility rule it is already handled.
        const rows: ExistingMessage[] = [{ recipientId: "r1", status: "failed" }];
        const eligible = eligibleRecipients(rows, recipients);
        expect(eligible.map((r) => r.id)).toEqual(["r2", "r3"]);
    });

    test("an unknown / future status still counts as handled (any row means skip)", () => {
        const rows: ExistingMessage[] = [{ recipientId: "r3", status: "queued" }];
        expect(eligibleRecipients(rows, recipients).map((r) => r.id)).toEqual(["r1", "r2"]);
    });

    test("existing rows for recipients not in the batch are ignored", () => {
        const rows: ExistingMessage[] = [
            { recipientId: "someone-else", status: "sent" },
            { recipientId: "r2", status: "attempted" },
        ];
        expect(eligibleRecipients(rows, recipients).map((r) => r.id)).toEqual(["r1", "r3"]);
    });

    test("a mix of handled and fresh recipients returns only the fresh ones", () => {
        const rows: ExistingMessage[] = [
            { recipientId: "r1", status: "sent" },
            { recipientId: "r3", status: "failed" },
        ];
        expect(eligibleRecipients(rows, recipients)).toEqual([{ id: "r2", name: "Bob" }]);
    });
});
