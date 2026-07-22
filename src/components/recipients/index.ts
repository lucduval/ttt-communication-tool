export { ContactList, type Contact } from "./ContactList";
export { useRecipientSelection } from "./useRecipientSelection";
export { useRecipientSample } from "./useRecipientSample";
export { useRecipientPagination } from "./useRecipientPagination";
export { filterSignature } from "./filterSignature";
export { materialiseExplicit } from "./materialiseExplicit";
export { UploadListPanel, type UploadRolesResult } from "./UploadListPanel";
export { UploadPreviewSample } from "./UploadPreviewSample";
export { buildPreviewMessages, buildMergeContext, type PreviewMessage } from "./previewSample";
export {
    extractContactIds,
    extractContactIdsForColumn,
    type ContactIdExtraction,
    type DetectedColumn,
} from "./extractContactIds";
export {
    readContactIdsFromFile,
    extractContactIdsForColumnFromFile,
    readUploadedColumnsFromFile,
    parseCsv,
    parseXlsx,
} from "./readContactIds";
export {
    parseUploadedColumns,
    materialiseRecipients,
    resolveColumnRoles,
    prepareUploadForSend,
    toUploadRecipient,
    type UploadRecipient,
    type PrepareUploadResult,
    type ValidationContext,
    type UploadedColumns,
    type UploadedColumnsStatus,
    type ColumnRoles,
    type PersistedColumnRoles,
    type UnresolvedRole,
    type ResolveColumnRolesResult,
    type MaterialisedRecipient,
    type MaterialiseResult,
    type HeldRow,
    type HeldReason,
} from "./columnRoles";
export {
    templateVariableFields,
    guessVariableMapping,
    validateVariableMapping,
    serialiseVariableMapping,
    type WhatsAppTemplateShape,
    type TemplateVariableField,
    type VariableMappingValidation,
} from "./whatsappVariableMapping";
export {
    buildValidationReport,
    extractPlaceholders,
    isValidSendAddress,
    BUILT_IN_PLACEHOLDERS,
    type PdfStatus,
    type ValidationHoldReason,
    type ValidationHold,
    type ValidationReport,
} from "./validationReport";
