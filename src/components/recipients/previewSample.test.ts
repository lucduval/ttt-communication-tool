import { describe, it, expect } from "vitest";
import { buildMergeContext, buildPreviewMessages } from "./previewSample";
import { composeEmailContent } from "../../../convex/lib/composeEmailContent";
import type { MaterialisedRecipient } from "./columnRoles";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

/** A materialised recipient with sensible defaults — the exact shape `report.sendable` carries. */
function recipient(overrides: Partial<MaterialisedRecipient> = {}): MaterialisedRecipient {
    return {
        rowIndex: 0,
        recipientId: A,
        sendAddress: "alice@example.com",
        invoiceGuid: "inv-guid-a",
        variables: { Amount: "R1,200.00", InvoiceNo: "INV-001" },
        ...overrides,
    };
}

describe("buildMergeContext", () => {
    it("layers the row bag over the built-in tokens, so a `{column}` resolves to its cell", () => {
        const ctx = buildMergeContext(
            recipient({ variables: { Amount: "R99.00" }, sendAddress: "bob@example.com" }),
        );
        expect(ctx.Amount).toBe("R99.00");
        // Built-ins are present so `{email}` still resolves on the upload path.
        expect(ctx.email).toBe("bob@example.com");
        // The upload path carries no name, so firstName/fullName render empty (never raw).
        expect(ctx.firstName).toBe("");
        expect(ctx.fullName).toBe("");
    });

    it("lets a row column named `email` override the built-in, mirroring the send path", () => {
        const ctx = buildMergeContext(
            recipient({ sendAddress: "send-to@example.com", variables: { email: "row@example.com" } }),
        );
        expect(ctx.email).toBe("row@example.com");
    });

    it("uses an empty string for `email` when no send-address role is designated", () => {
        const ctx = buildMergeContext(recipient({ sendAddress: null, variables: {} }));
        expect(ctx.email).toBe("");
    });
});

describe("buildPreviewMessages", () => {
    it("renders subject and body with the real merge engine (not a mock)", () => {
        const [msg] = buildPreviewMessages(
            "Outstanding: {Amount}",
            "<p>Invoice {InvoiceNo} for {Amount}</p>",
            [recipient()],
            5,
        );
        expect(msg.subject).toBe("Outstanding: R1,200.00");
        expect(msg.body).toBe("<p>Invoice INV-001 for R1,200.00</p>");
    });

    it("never emits a raw {placeholder} for a column the row lacks", () => {
        const [msg] = buildPreviewMessages("Hi {Missing}", "{AlsoMissing}", [recipient()], 5);
        expect(msg.subject).toBe("Hi ");
        expect(msg.body).toBe("");
        expect(msg.subject).not.toContain("{");
        expect(msg.body).not.toContain("{");
    });

    it("carries each recipient's send address and invoice GUID for the attachment view", () => {
        const [msg] = buildPreviewMessages("s", "b", [recipient()], 5);
        expect(msg.recipientId).toBe(A);
        expect(msg.sendAddress).toBe("alice@example.com");
        expect(msg.invoiceGuid).toBe("inv-guid-a");
    });

    it("draws from the validated rows in order and caps at the sample size", () => {
        const recipients = [
            recipient({ recipientId: A, variables: { Amount: "R1.00" } }),
            recipient({ recipientId: B, rowIndex: 1, variables: { Amount: "R2.00" } }),
            recipient({ recipientId: C, rowIndex: 2, variables: { Amount: "R3.00" } }),
        ];
        const msgs = buildPreviewMessages("{Amount}", "x", recipients, 2);
        expect(msgs.map((m) => m.recipientId)).toEqual([A, B]);
        expect(msgs.map((m) => m.subject)).toEqual(["R1.00", "R2.00"]);
    });

    it("returns an empty sample when there are no sendable recipients", () => {
        expect(buildPreviewMessages("{Amount}", "x", [], 5)).toEqual([]);
    });

    it("treats a non-positive sample size as an empty sample", () => {
        expect(buildPreviewMessages("{Amount}", "x", [recipient()], 0)).toEqual([]);
    });

    it("exposes the row's merged values so the operator can eyeball each cell", () => {
        const [msg] = buildPreviewMessages("s", "b", [recipient()], 1);
        expect(msg.mergedValues).toEqual({ Amount: "R1,200.00", InvoiceNo: "INV-001" });
    });
});

describe("buildPreviewMessages — preview↔send fidelity (PRD #74, #75)", () => {
    const UNSUB = "https://app.example.com/unsubscribe";

    it("reflects the Marketing unsubscribe footer when a URL is configured", () => {
        const [msg] = buildPreviewMessages("s", "<p>Body</p>", [recipient()], 1, {
            emailType: "marketing",
            unsubscribeUrl: UNSUB,
        });
        expect(msg.body).toContain("<p>Body</p>");
        expect(msg.body).toContain("unsubscribe here");
    });

    it("omits the unsubscribe footer for a Utility send even when a URL is configured", () => {
        const [msg] = buildPreviewMessages("s", "<p>Body</p>", [recipient()], 1, {
            emailType: "utility",
            unsubscribeUrl: UNSUB,
        });
        expect(msg.body).toBe("<p>Body</p>");
        expect(msg.body).not.toContain("unsubscribe here");
    });

    it("matches composeEmailContent exactly — the preview is the core", () => {
        const [msg] = buildPreviewMessages("s", "<p>{Amount}</p>", [recipient()], 1, {
            emailType: "marketing",
            unsubscribeUrl: UNSUB,
        });
        expect(msg.body).toBe(
            composeEmailContent({
                body: "<p>R1,200.00</p>",
                emailType: "marketing",
                unsubscribeUrl: UNSUB,
                disclaimerHtml: "",
            }),
        );
    });

    it("omits the footer when no unsubscribe URL is configured, regardless of type", () => {
        const [msg] = buildPreviewMessages("s", "<p>Body</p>", [recipient()], 1, {
            emailType: "marketing",
        });
        expect(msg.body).toBe("<p>Body</p>");
    });
});

describe("buildPreviewMessages — disclaimer append + merge (issue #77)", () => {
    const UNSUB = "https://app.example.com/unsubscribe";

    it("appends the merged disclaimer after the body and before the unsubscribe footer", () => {
        const [msg] = buildPreviewMessages(
            "s",
            "<p>Body</p>",
            [recipient()],
            1,
            {
                emailType: "marketing",
                unsubscribeUrl: UNSUB,
                disclaimerHtml: "<small>Owed: {Amount}</small>",
            },
        );
        const bodyIdx = msg.body.indexOf("<p>Body</p>");
        const disclaimerIdx = msg.body.indexOf("Owed: R1,200.00");
        const footerIdx = msg.body.indexOf("unsubscribe here");
        // Merge runs over the disclaimer exactly as over the body.
        expect(disclaimerIdx).toBeGreaterThan(bodyIdx);
        expect(footerIdx).toBeGreaterThan(disclaimerIdx);
    });

    it("renders an unknown placeholder in the disclaimer empty — never a raw token", () => {
        const [msg] = buildPreviewMessages("s", "<p>Body</p>", [recipient()], 1, {
            disclaimerHtml: "<small>Hi {missingColumn}!</small>",
        });
        expect(msg.body).toContain("<small>Hi !</small>");
        expect(msg.body).not.toContain("{missingColumn}");
    });

    it("appends nothing when no disclaimer is selected (None)", () => {
        const [msg] = buildPreviewMessages("s", "<p>Body</p>", [recipient()], 1, {
            emailType: "marketing",
        });
        expect(msg.body).toBe("<p>Body</p>");
    });
});
