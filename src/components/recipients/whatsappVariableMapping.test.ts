import { describe, it, expect } from "vitest";
import {
    templateVariableFields,
    guessVariableMapping,
    validateVariableMapping,
    serialiseVariableMapping,
    type WhatsAppTemplateShape,
} from "./whatsappVariableMapping";
import type { DetectedColumn } from "./extractContactIds";

// The seed bad-debt WhatsApp template shape: positional body vars {{1}}{{2}}{{3}}
// plus a dynamic "Pay now" URL button whose suffix is the payment token, with the
// default logical names the seed documents (`DEFAULT_MAPPINGS`).
const seedTemplate: WhatsAppTemplateShape = {
    variables: ["1", "2", "3"],
    variableMappings: JSON.stringify({
        "1": "first_name",
        "2": "invoice_number",
        "3": "amount_formatted",
        payment_link: "payment_link",
    }),
    buttonUrlVariable: "payment_link",
};

function cols(...headers: string[]): DetectedColumn[] {
    return headers.map((header, index) => ({ index, header }));
}

describe("templateVariableFields — human-readable labels from the template definition", () => {
    it("labels each positional body variable from its default logical name (not the bare token)", () => {
        const fields = templateVariableFields(seedTemplate);
        const body = fields.filter((f) => f.kind === "body");
        expect(body.map((f) => ({ name: f.name, position: f.position, label: f.label }))).toEqual([
            { name: "1", position: "1", label: "First name" },
            { name: "2", position: "2", label: "Invoice number" },
            { name: "3", position: "3", label: "Amount formatted" },
        ]);
    });

    it("includes the button/payment-link variable, labelled and after the body variables", () => {
        const fields = templateVariableFields(seedTemplate);
        expect(fields.map((f) => f.name)).toEqual(["1", "2", "3", "payment_link"]);
        const button = fields.find((f) => f.name === "payment_link");
        expect(button).toMatchObject({ kind: "button", position: null, label: "Payment link" });
    });

    it("includes a second dynamic URL button variable when present", () => {
        const fields = templateVariableFields({
            variables: ["1"],
            buttonUrlVariable: "payment_link",
            button2UrlVariable: "booking_ref",
        });
        expect(fields.map((f) => f.name)).toEqual(["1", "payment_link", "booking_ref"]);
        expect(fields.filter((f) => f.kind === "button").map((f) => f.name)).toEqual([
            "payment_link",
            "booking_ref",
        ]);
    });

    it("falls back to the variable name when the template documents no default mapping", () => {
        const fields = templateVariableFields({ variables: ["1"], buttonUrlVariable: "pay" });
        // No variableMappings → label derives from the name itself.
        expect(fields.find((f) => f.name === "pay")?.label).toBe("Pay");
    });
});

describe("guessVariableMapping — pre-fill from conventional headers", () => {
    it("matches exact snake_case headers for every variable including the button", () => {
        const fields = templateVariableFields(seedTemplate);
        const guess = guessVariableMapping(
            fields,
            cols("contactid", "first_name", "invoice_number", "amount_formatted", "payment_link"),
        );
        expect(guess).toEqual({
            "1": "first_name",
            "2": "invoice_number",
            "3": "amount_formatted",
            payment_link: "payment_link",
        });
    });

    it("matches humanised 'Title Case' headers (survives a re-export that relabels columns)", () => {
        const fields = templateVariableFields(seedTemplate);
        const guess = guessVariableMapping(
            fields,
            cols("First Name", "Invoice Number", "Amount Formatted", "Payment Link"),
        );
        expect(guess).toEqual({
            "1": "First Name",
            "2": "Invoice Number",
            "3": "Amount Formatted",
            payment_link: "Payment Link",
        });
    });

    it("matches a positional column literally named after the position (send-path fallback parity)", () => {
        const fields = templateVariableFields({ variables: ["1", "2"], buttonUrlVariable: null });
        // No variableMappings, so defaults are the positions themselves.
        const guess = guessVariableMapping(fields, cols("1", "2"));
        expect(guess).toEqual({ "1": "1", "2": "2" });
    });

    it("leaves a variable unmapped when no column plausibly matches", () => {
        const fields = templateVariableFields(seedTemplate);
        const guess = guessVariableMapping(fields, cols("first_name", "amount_formatted"));
        // invoice number and the payment link have no column → absent from the guess.
        expect(guess).toEqual({ "1": "first_name", "3": "amount_formatted" });
    });
});

describe("validateVariableMapping — reports the specific unmapped variables", () => {
    const fields = templateVariableFields(seedTemplate);

    it("passes when every variable, including the button, is mapped", () => {
        const result = validateVariableMapping(fields, {
            "1": "first_name",
            "2": "invoice_number",
            "3": "amount_formatted",
            payment_link: "payment_link",
        });
        expect(result).toEqual({ complete: true, unmapped: [] });
    });

    it("names the button/payment-link variable when it alone is unmapped", () => {
        const result = validateVariableMapping(fields, {
            "1": "first_name",
            "2": "invoice_number",
            "3": "amount_formatted",
        });
        expect(result.complete).toBe(false);
        expect(result.unmapped.map((f) => f.name)).toEqual(["payment_link"]);
        expect(result.unmapped[0].label).toBe("Payment link");
    });

    it("reports every unmapped variable in field order (blank counts as unmapped)", () => {
        const result = validateVariableMapping(fields, { "1": "first_name", "2": "   " });
        expect(result.unmapped.map((f) => f.name)).toEqual(["2", "3", "payment_link"]);
    });

    it("treats a mapped header that is not in the upload as unmapped when columns are supplied", () => {
        const mapping = {
            "1": "first_name",
            "2": "invoice_number",
            "3": "amount_formatted",
            payment_link: "vanished_column",
        };
        const columns = cols("first_name", "invoice_number", "amount_formatted");
        expect(validateVariableMapping(fields, mapping, columns).unmapped.map((f) => f.name)).toEqual([
            "payment_link",
        ]);
    });
});

describe("serialiseVariableMapping — the campaign's whatsappVariableMappings JSON", () => {
    const fields = templateVariableFields(seedTemplate);

    it("emits only non-blank headers, keyed by logical variable name (send-path shape)", () => {
        const json = serialiseVariableMapping(fields, {
            "1": "First Name",
            "2": "  ",
            "3": "Amount",
            payment_link: "Token",
            extra_ignored: "nope",
        });
        expect(JSON.parse(json)).toEqual({ "1": "First Name", "3": "Amount", payment_link: "Token" });
    });

    it("serialises an all-blank mapping to {} so the field still round-trips", () => {
        expect(serialiseVariableMapping(fields, {})).toBe("{}");
    });
});
