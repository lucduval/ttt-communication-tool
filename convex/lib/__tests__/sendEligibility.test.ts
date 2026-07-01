/**
 * Send-path eligibility rule tests (PRD #55, slices #56 + #63).
 *
 * The eligibility rule is the core of the at-most-once idempotency seam: a
 * recipient is eligible to send iff it has NO `messages` row for the campaign
 * OR its row is still `pending`. A `pending` row is the seed `createBatches`
 * writes for every recipient up front — "created but never handed to a
 * provider" — so it stays eligible; #58's `attempted` marker is what advances
 * it out of eligibility the instant it is handed to Graph. Every other status
 * (attempted/sent/delivered/failed, or any unknown/future value) means
 * already-handled: skip. It is pure — no Convex ctx, no DB — so no-duplicate
 * behaviour is provable as a truth table without a live mailbox. These tests
 * mirror the pure-function style of campaignTally.test.ts.
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

    test("a recipient with a settled row (not `pending`) is treated as already-handled and skipped", () => {
        // Every status EXCEPT `pending` — the `attempted` marker, a clean
        // `sent`/`delivered`, and a terminal `failed` — means "already handled".
        // One recipient carries a row of each such status in turn; it must never
        // be eligible.
        const handledStatuses = MESSAGE_STATUSES.filter((s) => s !== "pending");
        for (const status of handledStatuses) {
            const rows: ExistingMessage[] = [{ recipientId: "r2", status }];
            expect(eligibleRecipients(rows, recipients)).toEqual([
                { id: "r1", name: "Alice" },
                { id: "r3", name: "Carol" },
            ]);
        }
    });

    test("a `pending` row is eligible — a fresh campaign whose recipients each have a createBatches-seeded `pending` row still sends to everyone (#63)", () => {
        // createBatches pre-creates a `pending` row for every recipient before
        // the driver runs. If `pending` blocked, the driver's eligibility query
        // would filter EVERYONE out and a fresh campaign would send zero emails.
        // `pending` means "not yet handed to a provider", so it stays eligible;
        // the `attempted` marker (#58) is what removes a recipient once handed to
        // Graph.
        const rows: ExistingMessage[] = recipients.map((r) => ({
            recipientId: r.id,
            status: "pending",
        }));
        expect(eligibleRecipients(rows, recipients)).toEqual(recipients);
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

    test("a `pending` recipient stays eligible alongside a settled `attempted` one (bounded-recovery case)", () => {
        // After a mid-batch crash: r1's chunk was marked `attempted` (handed to
        // Graph, must not resend), while r2 was never reached and is still
        // `pending` (never sent, must resend). r3 has no row. A recovery re-run
        // therefore resends r2 and r3 but not r1 — at-most-once holds.
        const rows: ExistingMessage[] = [
            { recipientId: "r1", status: "attempted" },
            { recipientId: "r2", status: "pending" },
        ];
        expect(eligibleRecipients(rows, recipients).map((r) => r.id)).toEqual(["r2", "r3"]);
    });
});
