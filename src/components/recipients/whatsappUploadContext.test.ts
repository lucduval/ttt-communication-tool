/**
 * Regression for the defect that held the same 31 WhatsApp-only debtors in bad-debt
 * runs 5, 6, 7 and 8 (issue #94's fix was deployed and still did not fire).
 *
 * The gate itself was always right — `buildValidationReport` skips the send-address
 * check when it is given a WhatsApp context. The wizard built that context from
 * "a template with variables is selected" rather than from the campaign's channel,
 * so uploading the CSV before picking the template ran the email address check over
 * a WhatsApp file and held every row whose client has no email.
 *
 * These tests assert the context is a function of the channel alone.
 */
import { describe, it, expect } from "vitest";
import { whatsappUploadContext } from "./whatsappVariableMapping";
import { parseUploadedColumns, prepareUploadForSend } from "./columnRoles";
import type { TemplateVariableField } from "./whatsappVariableMapping";

const field = (name: string, defaultColumn: string): TemplateVariableField => ({
    name,
    kind: "body",
    position: name,
    defaultColumn,
    label: defaultColumn,
});

const FIELDS: TemplateVariableField[] = [field("1", "first_name"), field("2", "amount_formatted")];

describe("whatsappUploadContext", () => {
    it("is supplied for a WhatsApp campaign even before a template is picked", () => {
        expect(whatsappUploadContext("whatsapp", [], {})).toEqual({ fields: [], mapping: {} });
    });

    it("is supplied for a WhatsApp campaign once a template is picked", () => {
        const ctx = whatsappUploadContext("whatsapp", FIELDS, { "1": "first_name" });
        expect(ctx?.fields).toHaveLength(2);
    });

    it("is withheld for email and personalised campaigns", () => {
        expect(whatsappUploadContext("email", FIELDS, {})).toBeUndefined();
        expect(whatsappUploadContext("personalised", FIELDS, {})).toBeUndefined();
    });
});

describe("the wizard ordering no longer changes who is sendable", () => {
    // Two WhatsApp-only debtors: valid mobile, WhatsApp opt-in, no email address.
    // Under the old call site these were held on `invalid-send-address`.
    const rows = [
        ["Contact ID", "email", "mobile", "first_name", "amount_formatted"],
        ["11111111-1111-1111-1111-111111111111", "has@mail.co.za", "0821234567", "Ann", "R1 000.00"],
        ["22222222-2222-2222-2222-222222222222", "", "0837654321", "Bo", "R2 000.00"],
        ["33333333-3333-3333-3333-333333333333", "", "0845551234", "Cy", "R3 000.00"],
    ];
    const roles = {
        trackingKey: "Contact ID",
        sendAddress: "email", // guessRoles designates it from the email header, as in the real files
        phone: "mobile",
    };
    /** Run the gate as the wizard would, and return the report it shows the operator. */
    const report = (
        channel: "email" | "whatsapp" | "personalised",
        fields: TemplateVariableField[],
    ) => {
        const result = prepareUploadForSend(parseUploadedColumns(rows), roles, {
            placeholders: [],
            whatsapp: whatsappUploadContext(channel, fields, {
                "1": "first_name",
                "2": "amount_formatted",
            }),
        });
        if (result.status !== "ok" || !result.report) throw new Error(result.status);
        return result.report;
    };

    it("sends all three on WhatsApp whether or not a template was picked first", () => {
        expect(report("whatsapp", FIELDS).sendable).toHaveLength(3); // template picked first
        expect(report("whatsapp", []).sendable).toHaveLength(3); // file uploaded first
    });

    it("still holds the blank-email rows on an email campaign", () => {
        const emailReport = report("email", FIELDS);
        expect(emailReport.sendable).toHaveLength(1);
        expect(emailReport.held.flatMap((h) => h.reasons)).toContain("invalid-send-address");
    });
});
