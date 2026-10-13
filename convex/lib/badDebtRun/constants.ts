/** Campaign settings every run since 10 was uploaded with. */

/** Column roles: tracking key, send address, phone, invoice PDF, consultant CC. */
export const RUN_COLUMN_ROLES = {
    trackingKey: "Contact ID",
    sendAddress: "email",
    phone: "mobile",
    invoiceGuid: "invoice_id",
    ccAddress: "consultant_email",
};

/** `ttt_invoice_reminder_paylink_prod`'s variable mapping. The button takes the bare token. */
export const RUN_WHATSAPP_MAPPING: Record<string, string> = {
    "1": "first_name",
    "2": "invoice_number",
    "3": "amount_formatted",
    payment_link: "payment_token",
};
