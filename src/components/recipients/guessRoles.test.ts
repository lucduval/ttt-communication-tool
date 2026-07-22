/**
 * Header auto-detect tests for the upload panel's role guess (issue #83, PRD #78).
 *
 * These pin the pure header→role guess used to pre-fill the role dropdowns on file
 * drop, focusing on the new optional Consultant CC role (`ccAddress`): a likely
 * consultant-email header is pre-filled so the operator just confirms, while the
 * existing roles keep guessing as before and an absent consultant column stays
 * blank (the operator opts in).
 */
import { describe, it, expect } from "vitest";
import { guessRoles } from "./UploadListPanel";
import type { DetectedColumn } from "./extractContactIds";

const cols = (...headers: string[]): DetectedColumn[] =>
    headers.map((header, index) => ({ index, header }));

describe("guessRoles — consultant CC auto-detect", () => {
    it("pre-fills a 'Consultant Email' header as the CC role", () => {
        const roles = guessRoles(cols("Email", "Contact ID", "Consultant Email"));
        expect(roles.ccAddress).toBe("Consultant Email");
    });

    it("prefers a consultant *email* column over a bare consultant column", () => {
        const roles = guessRoles(cols("Consultant Name", "Consultant Email", "Contact ID"));
        expect(roles.ccAddress).toBe("Consultant Email");
    });

    it("falls back to a bare consultant column when no consultant-email header exists", () => {
        const roles = guessRoles(cols("Consultant", "Contact ID"));
        expect(roles.ccAddress).toBe("Consultant");
    });

    it("leaves the CC role blank when no consultant column is present", () => {
        const roles = guessRoles(cols("Email", "Contact ID", "Invoice GUID"));
        expect(roles.ccAddress).toBe("");
    });

    it("does not disturb the existing role guesses", () => {
        const roles = guessRoles(cols("Email", "Contact ID", "Consultant Email"));
        expect(roles.sendAddress).toBe("Email");
        expect(roles.trackingKey).toBe("Contact ID");
    });
});

describe("guessRoles — phone auto-detect (WhatsApp destination, issue #85)", () => {
    it.each(["Phone", "Mobile", "Cell", "MSISDN", "WhatsApp", "Mobile Number", "Cell Phone"])(
        "pre-fills a %s header as the phone role",
        (header) => {
            const roles = guessRoles(cols("Contact ID", header));
            expect(roles.phone).toBe(header);
        },
    );

    it("leaves the phone role blank when no mobile-number column is present", () => {
        const roles = guessRoles(cols("Email", "Contact ID", "Invoice GUID"));
        expect(roles.phone).toBe("");
    });

    it("does not populate the send address from a phone column, nor vice versa", () => {
        const roles = guessRoles(cols("Contact ID", "Mobile"));
        expect(roles.phone).toBe("Mobile");
        expect(roles.sendAddress).toBe("");
    });
});
