import { describe, it, expect } from "vitest";
import {
    parseUploadedColumns,
    materialiseRecipients,
    resolveColumnRoles,
    prepareUploadForSend,
    toUploadRecipient,
    type ColumnRoles,
} from "./columnRoles";

// Distinct Dynamics-shaped GUIDs to draw on.
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

// The invoice-GUID column is a *distinct* GUID from the tracking key.
const INV_A = "aaaaaaaa-0000-0000-0000-000000000001";
const INV_B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("parseUploadedColumns (retain every column)", () => {
    it("retains all column headers rather than extracting one id column", () => {
        const result = parseUploadedColumns([
            ["Full Name", "Email", "Contact", "Amount"],
            ["Alice", "alice@example.com", A, "R1,200.00"],
        ]);
        expect(result.status).toBe("ok");
        expect(result.columns).toEqual([
            { index: 0, header: "Full Name" },
            { index: 1, header: "Email" },
            { index: 2, header: "Contact" },
            { index: 3, header: "Amount" },
        ]);
    });

    it("trims header cells", () => {
        const result = parseUploadedColumns([["  Full Name  ", " Email "], ["Alice", "a@x.com"]]);
        expect(result.columns.map((c) => c.header)).toEqual(["Full Name", "Email"]);
    });

    it("strips the header row and keeps full data rows", () => {
        const result = parseUploadedColumns([
            ["name", "email"],
            ["Alice", "alice@example.com"],
            ["Bob", "bob@example.com"],
        ]);
        expect(result.dataRows).toEqual([
            ["Alice", "alice@example.com"],
            ["Bob", "bob@example.com"],
        ]);
    });

    it("pads short data rows to the header width so cell access is safe", () => {
        const result = parseUploadedColumns([
            ["name", "email", "amount"],
            ["Alice", "alice@example.com"], // missing the amount cell
        ]);
        expect(result.dataRows).toEqual([["Alice", "alice@example.com", ""]]);
    });

    it("returns empty status for a file with no rows at all", () => {
        const result = parseUploadedColumns([]);
        expect(result.status).toBe("empty");
        expect(result.columns).toEqual([]);
        expect(result.dataRows).toEqual([]);
    });

    it("returns ok with no data rows for a headers-only file", () => {
        const result = parseUploadedColumns([["name", "email"]]);
        expect(result.status).toBe("ok");
        expect(result.columns.map((c) => c.header)).toEqual(["name", "email"]);
        expect(result.dataRows).toEqual([]);
    });
});

describe("materialiseRecipients (tracking-key identity + variables bag)", () => {
    // A representative bad-debt export: name, email (send address), contact GUID
    // (tracking key), invoice GUID, and pre-formatted merge columns.
    const roles: ColumnRoles = { sendAddress: 1, trackingKey: 2, invoiceGuid: 3, ccAddress: null, phone: null };
    const uploaded = parseUploadedColumns([
        ["Full Name", "Email", "Contact", "InvoiceGuid", "Amount"],
        ["Alice", "alice@example.com", A, INV_A, "R1,200.00"],
        ["Bob", "bob@example.com", B, INV_B, "R980.00"],
    ]);

    it("keys each recipient by the normalised tracking-key value (the recipientId slot)", () => {
        const { recipients } = materialiseRecipients(uploaded, roles);
        expect(recipients.map((r) => r.recipientId)).toEqual([A, B]);
    });

    it("normalises the tracking key (braces stripped, lower-cased) into recipientId", () => {
        const braced = parseUploadedColumns([
            ["Email", "Contact"],
            ["alice@example.com", `{${A.toUpperCase()}}`],
        ]);
        const { recipients } = materialiseRecipients(braced, {
            sendAddress: 0,
            trackingKey: 1,
            invoiceGuid: null,
            ccAddress: null,
            phone: null,
        });
        expect(recipients[0].recipientId).toBe(A);
    });

    it("extracts the send-address cell for the designated column", () => {
        const { recipients } = materialiseRecipients(uploaded, roles);
        expect(recipients.map((r) => r.sendAddress)).toEqual([
            "alice@example.com",
            "bob@example.com",
        ]);
    });

    it("extracts the invoice-GUID cell for the designated column", () => {
        const { recipients } = materialiseRecipients(uploaded, roles);
        expect(recipients.map((r) => r.invoiceGuid)).toEqual([INV_A, INV_B]);
    });

    it("populates the variables bag with every column of the row, keyed by header", () => {
        const { recipients } = materialiseRecipients(uploaded, roles);
        expect(recipients[0].variables).toEqual({
            "Full Name": "Alice",
            Email: "alice@example.com",
            Contact: A,
            InvoiceGuid: INV_A,
            Amount: "R1,200.00",
        });
    });

    it("keeps cell values exactly as uploaded (flat merge does no formatting)", () => {
        const spaced = parseUploadedColumns([
            ["Contact", "Amount"],
            [A, "  R1,200.00  "],
        ]);
        const { recipients } = materialiseRecipients(spaced, {
            sendAddress: null,
            trackingKey: 0,
            invoiceGuid: null,
            ccAddress: null,
            phone: null,
        });
        expect(recipients[0].variables.Amount).toBe("  R1,200.00  ");
    });

    it("leaves sendAddress and invoiceGuid null when those roles are unassigned", () => {
        const { recipients } = materialiseRecipients(uploaded, {
            sendAddress: null,
            trackingKey: 2,
            invoiceGuid: null,
            ccAddress: null,
            phone: null,
        });
        expect(recipients[0].sendAddress).toBeNull();
        expect(recipients[0].invoiceGuid).toBeNull();
        expect(recipients[0].phone).toBeNull();
    });
});

describe("resolveColumnRoles (persisted-by-header → index designation)", () => {
    // The columns as read back from a (possibly re-exported) upload.
    const columns = parseUploadedColumns([
        ["Full Name", "Email", "Contact", "InvoiceGuid", "Amount"],
    ]).columns;

    it("resolves each persisted header to its column index", () => {
        const result = resolveColumnRoles(columns, {
            sendAddress: "Email",
            trackingKey: "Contact",
            invoiceGuid: "InvoiceGuid",
        });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: 1, trackingKey: 2, invoiceGuid: 3, ccAddress: null, phone: null },
        });
    });

    it("leaves optional roles null when their header is unset (absent, null, or blank)", () => {
        const result = resolveColumnRoles(columns, { trackingKey: "Contact" });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: null, trackingKey: 2, invoiceGuid: null, ccAddress: null, phone: null },
        });
        expect(
            resolveColumnRoles(columns, {
                sendAddress: null,
                trackingKey: "Contact",
                invoiceGuid: "  ",
                ccAddress: "  ",
            }),
        ).toEqual({
            status: "ok",
            roles: { sendAddress: null, trackingKey: 2, invoiceGuid: null, ccAddress: null, phone: null },
        });
    });

    it("resolves against columns reordered by a re-export, as long as headers match (durability)", () => {
        const reordered = parseUploadedColumns([
            ["Amount", "Contact", "Email"], // same headers, different order
        ]).columns;
        const result = resolveColumnRoles(reordered, {
            sendAddress: "Email",
            trackingKey: "Contact",
        });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: 2, trackingKey: 1, invoiceGuid: null, ccAddress: null, phone: null },
        });
    });

    it("trims persisted headers before matching the (already-trimmed) columns", () => {
        const result = resolveColumnRoles(columns, { trackingKey: "  Contact  " });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: null, trackingKey: 2, invoiceGuid: null, ccAddress: null, phone: null },
        });
    });

    it("reports the required tracking-key role as unresolved when its header is gone", () => {
        const result = resolveColumnRoles(columns, { trackingKey: "ContactId" });
        expect(result).toEqual({
            status: "unresolved",
            unresolved: [{ role: "trackingKey", header: "ContactId" }],
        });
    });

    it("reports a designated optional role whose header is gone, in role order", () => {
        const result = resolveColumnRoles(columns, {
            sendAddress: "EmailAddress",
            trackingKey: "Contact",
            invoiceGuid: "Invoice",
        });
        expect(result).toEqual({
            status: "unresolved",
            unresolved: [
                { role: "sendAddress", header: "EmailAddress" },
                { role: "invoiceGuid", header: "Invoice" },
            ],
        });
    });

    it("picks the first matching column when a header is duplicated", () => {
        const dupes = parseUploadedColumns([["Contact", "Email", "Contact"]]).columns;
        const result = resolveColumnRoles(dupes, { trackingKey: "Contact" });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: null, trackingKey: 0, invoiceGuid: null, ccAddress: null, phone: null },
        });
    });

    it("resolves a designated consultant-CC header to its column index (#79)", () => {
        const withCc = parseUploadedColumns([
            ["Email", "Contact", "Consultant"],
        ]).columns;
        const result = resolveColumnRoles(withCc, {
            sendAddress: "Email",
            trackingKey: "Contact",
            ccAddress: "Consultant",
        });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: 0, trackingKey: 1, invoiceGuid: null, ccAddress: 2, phone: null },
        });
    });

    it("leaves the consultant-CC role null when its header is unset (absent, null, or blank) (#79)", () => {
        expect(resolveColumnRoles(columns, { trackingKey: "Contact" }).status).toBe("ok");
        for (const ccAddress of [undefined, null, "   "]) {
            expect(resolveColumnRoles(columns, { trackingKey: "Contact", ccAddress })).toEqual({
                status: "ok",
                roles: { sendAddress: null, trackingKey: 2, invoiceGuid: null, ccAddress: null, phone: null },
            });
        }
    });

    it("reports a designated-but-missing consultant-CC header as unresolved, in role order (#79)", () => {
        const result = resolveColumnRoles(columns, {
            sendAddress: "EmailAddress",
            trackingKey: "Contact",
            ccAddress: "Consultant",
        });
        expect(result).toEqual({
            status: "unresolved",
            unresolved: [
                { role: "sendAddress", header: "EmailAddress" },
                { role: "ccAddress", header: "Consultant" },
            ],
        });
    });

    it("carries the consultant-CC cell into the materialised variables bag (existing every-column rule) (#79)", () => {
        const uploaded = parseUploadedColumns([
            ["Email", "Contact", "Consultant"],
            ["alice@example.com", A, "consultant@firm.com"],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            sendAddress: "Email",
            trackingKey: "Contact",
            ccAddress: "Consultant",
        });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") return;
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(recipients[0].variables.Consultant).toBe("consultant@firm.com");
    });

    it("feeds straight into materialiseRecipients (the AC #4 → #5 bridge)", () => {
        const uploaded = parseUploadedColumns([
            ["Email", "Contact"],
            ["alice@example.com", "11111111-1111-1111-1111-111111111111"],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            sendAddress: "Email",
            trackingKey: "Contact",
        });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") return;
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(recipients.map((r) => r.recipientId)).toEqual([
            "11111111-1111-1111-1111-111111111111",
        ]);
        expect(recipients[0].sendAddress).toBe("alice@example.com");
    });
});

describe("materialiseRecipients (held rows — the single-invoice hard gate)", () => {
    const roles: ColumnRoles = { sendAddress: 1, trackingKey: 2, invoiceGuid: null, ccAddress: null, phone: null };

    it("holds a row whose tracking-key cell is blank", () => {
        const uploaded = parseUploadedColumns([
            ["Name", "Email", "Contact"],
            ["Alice", "alice@example.com", A],
            ["Bob", "bob@example.com", ""],
        ]);
        const { recipients, held } = materialiseRecipients(uploaded, roles);
        expect(recipients.map((r) => r.recipientId)).toEqual([A]);
        expect(held).toEqual([{ rowIndex: 1, reason: "missing-tracking-key", trackingKey: "" }]);
    });

    it("holds a row whose tracking-key cell is not a GUID", () => {
        const uploaded = parseUploadedColumns([
            ["Name", "Email", "Contact"],
            ["Alice", "alice@example.com", "not-a-guid"],
        ]);
        const { recipients, held } = materialiseRecipients(uploaded, roles);
        expect(recipients).toEqual([]);
        expect(held).toEqual([
            { rowIndex: 0, reason: "missing-tracking-key", trackingKey: "not-a-guid" },
        ]);
    });

    it("holds EVERY row sharing a duplicated tracking key (multi-invoice contact), never collapses", () => {
        const uploaded = parseUploadedColumns([
            ["Name", "Email", "Contact"],
            ["Alice inv 1", "alice@example.com", A],
            ["Bob", "bob@example.com", B],
            ["Alice inv 2", "alice@example.com", A.toUpperCase()], // same contact, second invoice
        ]);
        const { recipients, held } = materialiseRecipients(uploaded, roles);
        // Only the genuinely-single-invoice contact (Bob) survives.
        expect(recipients.map((r) => r.recipientId)).toEqual([B]);
        expect(held).toEqual([
            { rowIndex: 0, reason: "duplicate-tracking-key", trackingKey: A },
            { rowIndex: 2, reason: "duplicate-tracking-key", trackingKey: A },
        ]);
    });

    it("held rowIndex is 0-based into data rows (excludes the header)", () => {
        const uploaded = parseUploadedColumns([
            ["Name", "Email", "Contact"],
            ["Alice", "alice@example.com", A], // rowIndex 0 — ok
            ["Bad", "bad@example.com", ""], // rowIndex 1 — held
        ]);
        const { held } = materialiseRecipients(uploaded, roles);
        expect(held[0].rowIndex).toBe(1);
    });

    it("yields no recipients and no held rows for a headers-only upload", () => {
        const uploaded = parseUploadedColumns([["Name", "Email", "Contact"]]);
        const { recipients, held } = materialiseRecipients(uploaded, roles);
        expect(recipients).toEqual([]);
        expect(held).toEqual([]);
    });
});

describe("prepareUploadForSend (materialised rows → send payload — AC #5)", () => {
    // A CRM-shaped export: identity in "Contact", the address in "Email",
    // an invoice GUID column, and pre-rendered merge columns.
    const upload = () =>
        parseUploadedColumns([
            ["Full Name", "Email", "Contact", "InvoiceGuid", "Amount"],
            ["Alice", "alice@example.com", A, INV_A, "R1,200.00"],
            ["Bob", "bob@example.com", B, INV_B, "R980.00"],
        ]);

    const persisted = {
        sendAddress: "Email",
        trackingKey: "Contact",
        invoiceGuid: "InvoiceGuid",
    };

    it("passes the unresolved status through when a designated header is missing", () => {
        const result = prepareUploadForSend(upload(), {
            trackingKey: "NoSuchColumn",
        });
        expect(result.status).toBe("unresolved");
        if (result.status !== "unresolved") throw new Error("expected unresolved");
        expect(result.unresolved).toEqual([{ role: "trackingKey", header: "NoSuchColumn" }]);
    });

    it("materialises recipients keyed by the tracking-key value into the id slot", () => {
        const result = prepareUploadForSend(upload(), persisted);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients.map((r) => r.id)).toEqual([A, B]);
    });

    it("fills the required name slot with \"\" (the bad-debt model has no name role)", () => {
        const result = prepareUploadForSend(upload(), persisted);
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients.map((r) => r.name)).toEqual(["", ""]);
    });

    it("puts the send-address cell in the email slot", () => {
        const result = prepareUploadForSend(upload(), persisted);
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients.map((r) => r.email)).toEqual([
            "alice@example.com",
            "bob@example.com",
        ]);
    });

    it("carries the full row as a JSON-encoded variables bag (the merge source of truth)", () => {
        const result = prepareUploadForSend(upload(), persisted);
        if (result.status !== "ok") throw new Error("expected ok");
        expect(JSON.parse(result.recipients[0].variables)).toEqual({
            "Full Name": "Alice",
            Email: "alice@example.com",
            Contact: A,
            InvoiceGuid: INV_A,
            Amount: "R1,200.00",
        });
    });

    it("omits the email slot when no send-address role is designated (e.g. a WhatsApp upload)", () => {
        const result = prepareUploadForSend(upload(), {
            trackingKey: "Contact",
        });
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients[0].email).toBeUndefined();
    });

    it("refuses to send content-held rows when a validation context is supplied (#67)", () => {
        // Two clean-identity rows, but one has an empty referenced cell and a bad
        // email — the full gate must keep it out of the send payload.
        const uploaded = parseUploadedColumns([
            ["Email", "Contact", "Amount"],
            ["alice@example.com", A, "R1,200.00"], // clean → sends
            ["nope", B, ""], // bad email + empty {Amount} → held
        ]);
        const result = prepareUploadForSend(
            uploaded,
            { sendAddress: "Email", trackingKey: "Contact" },
            { placeholders: ["Amount"] },
        );
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients.map((r) => r.id)).toEqual([A]);
        expect(result.report?.held).toEqual([
            {
                rowIndex: 1,
                trackingKey: B,
                reasons: ["empty-referenced-cell", "invalid-send-address"],
            },
        ]);
    });

    it("holds no rows and omits the report when no validation context is supplied", () => {
        const result = prepareUploadForSend(upload(), persisted);
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.report).toBeUndefined();
        expect(result.recipients.map((r) => r.id)).toEqual([A, B]);
    });

    it("surfaces held rows (duplicate + missing tracking key) alongside the recipients for the report", () => {
        const uploaded = parseUploadedColumns([
            ["Email", "Contact", "Amount"],
            ["alice@example.com", A, "R1,200.00"], // ok
            ["dup@example.com", A, "R500.00"], // duplicate tracking key — held
            ["blank@example.com", "", "R700.00"], // missing tracking key — held
        ]);
        const result = prepareUploadForSend(uploaded, {
            sendAddress: "Email",
            trackingKey: "Contact",
        });
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients).toEqual([]);
        expect(result.held.map((h) => h.reason)).toEqual([
            "duplicate-tracking-key",
            "duplicate-tracking-key",
            "missing-tracking-key",
        ]);
    });
});

describe("phone column role (WhatsApp destination — PRD #84, issue #85)", () => {
    it("resolves a designated phone header to its column index", () => {
        const columns = parseUploadedColumns([["Contact", "Mobile"]]).columns;
        const result = resolveColumnRoles(columns, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        expect(result).toEqual({
            status: "ok",
            roles: { sendAddress: null, trackingKey: 0, invoiceGuid: null, ccAddress: null, phone: 1 },
        });
    });

    it("leaves the phone role null when its header is unset (absent, null, or blank)", () => {
        const columns = parseUploadedColumns([["Contact", "Mobile"]]).columns;
        for (const phone of [undefined, null, "   "]) {
            expect(resolveColumnRoles(columns, { trackingKey: "Contact", phone })).toEqual({
                status: "ok",
                roles: { sendAddress: null, trackingKey: 0, invoiceGuid: null, ccAddress: null, phone: null },
            });
        }
    });

    it("reports a designated-but-missing phone header as unresolved, last in role order", () => {
        const columns = parseUploadedColumns([["Email", "Contact"]]).columns;
        const result = resolveColumnRoles(columns, {
            sendAddress: "EmailAddress",
            trackingKey: "Contact",
            phone: "Mobile",
        });
        expect(result).toEqual({
            status: "unresolved",
            unresolved: [
                { role: "sendAddress", header: "EmailAddress" },
                { role: "phone", header: "Mobile" },
            ],
        });
    });

    it("carries the trimmed phone cell onto the materialised recipient", () => {
        const uploaded = parseUploadedColumns([
            ["Contact", "Mobile"],
            [A, "  +27 82 123 4567  "],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") return;
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(recipients[0].phone).toBe("+27 82 123 4567");
    });

    it("survives the persisted round-trip (index ↔ header) for the phone role", () => {
        const uploaded = parseUploadedColumns([
            ["Amount", "Mobile", "Contact"], // re-exported in a different order
            ["R1,200.00", "+27821234567", A],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") return;
        expect(resolved.roles.phone).toBe(1);
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(recipients[0].phone).toBe("+27821234567");
    });

    it("projects the phone cell into the send-payload recipient's phone field", () => {
        const uploaded = parseUploadedColumns([
            ["Contact", "Mobile"],
            [A, "+27821234567"],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        if (resolved.status !== "ok") throw new Error("expected ok");
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(toUploadRecipient(recipients[0]).phone).toBe("+27821234567");
    });

    it("omits the phone slot when no phone role is designated", () => {
        const uploaded = parseUploadedColumns([
            ["Email", "Contact"],
            ["alice@example.com", A],
        ]);
        const resolved = resolveColumnRoles(uploaded.columns, {
            sendAddress: "Email",
            trackingKey: "Contact",
        });
        if (resolved.status !== "ok") throw new Error("expected ok");
        const { recipients } = materialiseRecipients(uploaded, resolved.roles);
        expect(toUploadRecipient(recipients[0]).phone).toBeUndefined();
    });

    it("resolves each recipient's number through prepareUploadForSend for a WhatsApp upload (AC #8)", () => {
        // A WhatsApp export: identity + phone, no email/send-address role.
        const uploaded = parseUploadedColumns([
            ["Contact", "Mobile", "Amount"],
            [A, "+27821234567", "R1,200.00"],
            [B, "+27829876543", "R980.00"],
        ]);
        const result = prepareUploadForSend(uploaded, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.recipients.map((r) => r.phone)).toEqual([
            "+27821234567",
            "+27829876543",
        ]);
        // No send-address role → no email slot; the phone is the destination.
        expect(result.recipients.every((r) => r.email === undefined)).toBe(true);
    });

    it("keeps sendAddress (email) and phone distinct — designating one never populates the other", () => {
        const uploaded = parseUploadedColumns([
            ["Email", "Contact", "Mobile"],
            ["alice@example.com", A, "+27821234567"],
        ]);
        // Email designated, phone not.
        const emailOnly = resolveColumnRoles(uploaded.columns, {
            sendAddress: "Email",
            trackingKey: "Contact",
        });
        if (emailOnly.status !== "ok") throw new Error("expected ok");
        const emailRecipient = toUploadRecipient(materialiseRecipients(uploaded, emailOnly.roles).recipients[0]);
        expect(emailRecipient.email).toBe("alice@example.com");
        expect(emailRecipient.phone).toBeUndefined();

        // Phone designated, email not.
        const phoneOnly = resolveColumnRoles(uploaded.columns, {
            trackingKey: "Contact",
            phone: "Mobile",
        });
        if (phoneOnly.status !== "ok") throw new Error("expected ok");
        const phoneRecipient = toUploadRecipient(materialiseRecipients(uploaded, phoneOnly.roles).recipients[0]);
        expect(phoneRecipient.phone).toBe("+27821234567");
        expect(phoneRecipient.email).toBeUndefined();
    });
});
