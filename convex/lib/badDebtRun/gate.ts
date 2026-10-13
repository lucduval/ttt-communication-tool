/**
 * Put each run file through the SAME pre-send gate the campaign wizard runs in the
 * browser, so an automated run sends exactly what an operator uploading the file
 * would have sent, and holds exactly what they would have seen held.
 */
import {
    parseUploadedColumns,
    prepareUploadForSend,
} from "../../../src/components/recipients/columnRoles";
import { extractPlaceholders } from "../../../src/components/recipients/validationReport";
import {
    templateVariableFields,
    type WhatsAppTemplateShape,
} from "../../../src/components/recipients/whatsappVariableMapping";
import { toGrid, type RunRow } from "./audience";
import { RUN_COLUMN_ROLES, RUN_WHATSAPP_MAPPING } from "./constants";

export interface GateRecipient {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    variables?: string;
}

export interface GateResult {
    recipients: GateRecipient[];
    held: { id: string; reasons: string[] }[];
    warnings: string[];
}

export function gateFile(
    rows: readonly RunRow[],
    channel: "email" | "whatsapp",
    content: { subject: string; htmlBody: string } | { template: WhatsAppTemplateShape },
): GateResult {
    const uploaded = parseUploadedColumns(toGrid(rows));
    const placeholders = "template" in content
        ? []
        : extractPlaceholders(`${content.subject}\n${content.htmlBody}`);
    const whatsapp = "template" in content
        ? { fields: templateVariableFields(content.template), mapping: RUN_WHATSAPP_MAPPING }
        : undefined;
    const prepared = prepareUploadForSend(uploaded, RUN_COLUMN_ROLES, { placeholders, whatsapp });
    if (prepared.status !== "ok") {
        throw new Error(`column roles did not resolve: ${JSON.stringify(prepared.unresolved)}`);
    }
    // The report's `held` already includes the tracking-key holds.
    const report = prepared.report!;
    const warnings: string[] = [];
    if (report.unmatchedPlaceholders.length) warnings.push(`placeholders no column fills: ${report.unmatchedPlaceholders.join(", ")}`);
    if (report.unmappedVariables.length) warnings.push(`unmapped template variables: ${report.unmappedVariables.map((f) => f.name).join(", ")}`);
    if (channel === "whatsapp" && report.phoneColumnMissing) warnings.push("no phone column");
    const names = new Map(rows.map((r) => [r["Contact ID"], r.full_name]));
    return {
        recipients: prepared.recipients.map((r) => ({ ...r, name: names.get(r.id) ?? "" })),
        held: report.held.map((h) => ({ id: h.trackingKey, reasons: h.reasons })),
        warnings,
    };
}
