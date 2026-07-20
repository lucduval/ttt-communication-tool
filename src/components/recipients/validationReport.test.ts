import { describe, it, expect } from "vitest";
import {
    buildValidationReport,
    extractPlaceholders,
    isValidSendAddress,
    type PdfStatus,
} from "./validationReport";
import type { MaterialiseResult, MaterialisedRecipient } from "./columnRoles";

// Distinct tracking-key GUIDs to draw on.
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

/** Build a materialised recipient with sensible, fully-passing defaults. */
function recipient(overrides: Partial<MaterialisedRecipient> = {}): MaterialisedRecipient {
    return {
        rowIndex: 0,
        recipientId: A,
        sendAddress: "alice@example.com",
        invoiceGuid: null,
        variables: { Amount: "R1,200.00", Email: "alice@example.com" },
        ...overrides,
    };
}

/** A materialise result from sendable recipients + optional tracking-key holds. */
function rows(
    recipients: MaterialisedRecipient[],
    held: MaterialiseResult["held"] = [],
): MaterialiseResult {
    return { recipients, held };
}

describe("extractPlaceholders", () => {
    it("pulls distinct {placeholder} names from subject + body, in first-seen order", () => {
        expect(extractPlaceholders("Hi, you owe {Amount} on {InvoiceNo}. Pay {Amount}."))
            .toEqual(["Amount", "InvoiceNo"]);
    });

    it("trims names and ignores empty braces", () => {
        expect(extractPlaceholders("{ Amount } {} {  }")).toEqual(["Amount"]);
    });

    it("drops built-in tokens (they resolve without a column)", () => {
        expect(extractPlaceholders("Hi {firstName}, you owe {Amount}")).toEqual(["Amount"]);
    });

    it("returns [] for empty text", () => {
        expect(extractPlaceholders("")).toEqual([]);
    });
});

describe("isValidSendAddress", () => {
    it("accepts a complete address", () => {
        expect(isValidSendAddress("alice@example.com")).toBe(true);
        expect(isValidSendAddress("  bob@sub.example.co.za  ")).toBe(true);
    });

    it("rejects blank / incomplete / whitespace-bearing addresses", () => {
        expect(isValidSendAddress("")).toBe(false);
        expect(isValidSendAddress("alice@example")).toBe(false);
        expect(isValidSendAddress("alice.example.com")).toBe(false);
        expect(isValidSendAddress("alice @example.com")).toBe(false);
    });
});

describe("buildValidationReport — a fully-clean upload", () => {
    it("sends every row and holds none when all checks pass", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows([recipient(), recipient({ rowIndex: 1, recipientId: B })]),
        );
        expect(report.unmatchedPlaceholders).toEqual([]);
        expect(report.held).toEqual([]);
        expect(report.sendable.map((r) => r.recipientId)).toEqual([A, B]);
    });
});

describe("buildValidationReport — hold reasons (one each)", () => {
    it("holds every row when a placeholder has no matching column (campaign-level)", () => {
        const report = buildValidationReport(["Amount", "NoSuchColumn"], rows([recipient()]));
        expect(report.unmatchedPlaceholders).toEqual(["NoSuchColumn"]);
        expect(report.sendable).toEqual([]);
        expect(report.held).toEqual([
            { rowIndex: 0, trackingKey: A, reasons: ["unmatched-placeholder"] },
        ]);
    });

    it("holds a row whose referenced cell is empty", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows([recipient({ variables: { Amount: "   ", Email: "alice@example.com" } })]),
        );
        expect(report.sendable).toEqual([]);
        expect(report.held).toEqual([
            { rowIndex: 0, trackingKey: A, reasons: ["empty-referenced-cell"] },
        ]);
    });

    it("holds a row with an invalid send address", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows([recipient({ sendAddress: "not-an-email" })]),
        );
        expect(report.sendable).toEqual([]);
        expect(report.held).toEqual([
            { rowIndex: 0, trackingKey: A, reasons: ["invalid-send-address"] },
        ]);
    });

    it("does NOT run the address check when there is no send-address role (null)", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows([recipient({ sendAddress: null })]),
        );
        expect(report.held).toEqual([]);
        expect(report.sendable.map((r) => r.recipientId)).toEqual([A]);
    });

    it("holds a row whose PDF did not generate", () => {
        const pdfStatus: Record<string, PdfStatus> = { [A]: "failed" };
        const report = buildValidationReport(["Amount"], rows([recipient()]), pdfStatus);
        expect(report.sendable).toEqual([]);
        expect(report.held).toEqual([{ rowIndex: 0, trackingKey: A, reasons: ["missing-pdf"] }]);
    });

    it("holds a row whose PDF is still pending", () => {
        const report = buildValidationReport(["Amount"], rows([recipient()]), { [A]: "pending" });
        expect(report.held.map((h) => h.reasons)).toEqual([["missing-pdf"]]);
    });

    it("carries tracking-key holds (missing + duplicate) straight through", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows(
                [recipient()],
                [
                    { rowIndex: 1, reason: "duplicate-tracking-key", trackingKey: B },
                    { rowIndex: 2, reason: "missing-tracking-key", trackingKey: "oops" },
                ],
            ),
        );
        expect(report.sendable.map((r) => r.recipientId)).toEqual([A]);
        expect(report.held).toEqual([
            { rowIndex: 1, trackingKey: B, reasons: ["duplicate-tracking-key"] },
            { rowIndex: 2, trackingKey: "oops", reasons: ["missing-tracking-key"] },
        ]);
    });
});

describe("buildValidationReport — the PDF sentinel (pre-gen not wired yet)", () => {
    it("treats a recipient absent from the pdfStatus map as trivially-passing", () => {
        // No map at all → every row passes the PDF check.
        expect(buildValidationReport(["Amount"], rows([recipient()])).sendable).toHaveLength(1);
        // Explicit map that omits this recipient → still passes.
        const report = buildValidationReport(["Amount"], rows([recipient()]), { [B]: "failed" });
        expect(report.sendable.map((r) => r.recipientId)).toEqual([A]);
    });

    it("treats an explicit 'generated' status as passing", () => {
        const report = buildValidationReport(["Amount"], rows([recipient()]), { [A]: "generated" });
        expect(report.held).toEqual([]);
    });
});

describe("buildValidationReport — consolidation", () => {
    it("lists all reasons a single row fails (bad address + empty cell + missing pdf)", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows([
                recipient({
                    sendAddress: "bad",
                    variables: { Amount: "", Email: "bad" },
                }),
            ]),
            { [A]: "failed" },
        );
        expect(report.held).toEqual([
            {
                rowIndex: 0,
                trackingKey: A,
                reasons: ["empty-referenced-cell", "invalid-send-address", "missing-pdf"],
            },
        ]);
    });

    it("produces one report combining a content hold, a tracking-key hold, and a clean row, in row order", () => {
        const report = buildValidationReport(
            ["Amount"],
            rows(
                [
                    recipient({ rowIndex: 0 }), // clean
                    recipient({ rowIndex: 2, recipientId: B, sendAddress: "nope" }), // bad address
                ],
                [{ rowIndex: 1, reason: "missing-tracking-key", trackingKey: "" }],
            ),
        );
        expect(report.sendable.map((r) => r.recipientId)).toEqual([A]);
        expect(report.held).toEqual([
            { rowIndex: 1, trackingKey: "", reasons: ["missing-tracking-key"] },
            { rowIndex: 2, trackingKey: B, reasons: ["invalid-send-address"] },
        ]);
    });

    it("holds a clean row on unmatched-placeholder even though its own cells are fine", () => {
        const report = buildValidationReport(["Amount", "Missing"], rows([recipient()]));
        expect(report.held).toEqual([
            { rowIndex: 0, trackingKey: A, reasons: ["unmatched-placeholder"] },
        ]);
    });

    it("only flags empty-referenced-cell for placeholders that DO have a column", () => {
        // 'Missing' has no column → unmatched-placeholder; 'Amount' has an empty cell.
        const report = buildValidationReport(
            ["Amount", "Missing"],
            rows([recipient({ variables: { Amount: "", Email: "alice@example.com" } })]),
        );
        expect(report.held[0].reasons).toEqual(["unmatched-placeholder", "empty-referenced-cell"]);
    });
});
