"use client";

import { useState, useEffect, useCallback } from "react";
import { useAction, useQuery, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api";
import { Header } from "@/components/layout";
import { Button, Card, Badge, ConfirmationModal } from "@/components/ui";
import { EmailComposer, EmailPreview, TestEmailModal, MailboxSelector, LivePreviewModal } from "@/components/email";
import {
    ChannelSelector,
    TemplateSelector,
    WhatsAppPreview,
    TestWhatsAppModal,
} from "@/components/whatsapp";
import {
    ContactFilters,
    buildODataFilter,
    type FilterState,
} from "@/components/filters";
import { ContactList, type Contact } from "@/components/recipients";
import {
    ArrowLeft,
    ArrowRight,
    Users,
    Mail,
    MessageSquare,
    Eye,
    Send,
    TestTube,
    Loader2,
    CheckCircle,
    Zap,
    AlertTriangle,
    DollarSign,
} from "lucide-react";
import type { Doc, Id } from "@/../convex/_generated/dataModel";

type CampaignChannel = "email" | "whatsapp";
type WizardStep = "channel" | "recipients" | "compose" | "preview" | "send";

const STEPS: { id: WizardStep; label: string; icon: React.ElementType }[] = [
    { id: "channel", label: "Channel", icon: Zap },
    { id: "recipients", label: "Recipients", icon: Users },
    { id: "compose", label: "Compose", icon: Mail },
    { id: "preview", label: "Preview", icon: Eye },
    { id: "send", label: "Send", icon: Send },
];

const INITIAL_FILTERS: FilterState = {
    search: "",
    clientType: null,
    entityType: null,
    marketingType: "all",
    whatsappOptIn: null,
    emailEnabled: null,
    bank: null,
    sourceCode: [],
    province: null,
    ageMin: null,
    ageMax: null,
    ownerId: null,
    industryId: null,
};

interface UploadedImage {
    name: string;
    contentType: string;
    contentBase64: string;
}

export default function NewCampaignPage() {
    // Wizard state
    const [currentStep, setCurrentStep] = useState<WizardStep>("channel");
    const stepIndex = STEPS.findIndex((s) => s.id === currentStep);

    // Channel state
    const [campaignChannel, setCampaignChannel] = useState<CampaignChannel>("email");
    const [campaignTitle, setCampaignTitle] = useState("");

    // Recipients state
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [isLoadingContacts, setIsLoadingContacts] = useState(true);
    const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
    const [totalCount, setTotalCount] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectedContacts, setSelectedContacts] = useState<Contact[]>([]);

    // Email state
    const [subject, setSubject] = useState("");
    const [htmlContent, setHtmlContent] = useState("");
    const [fontSize, setFontSize] = useState("18px");
    const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
    const [attachments, setAttachments] = useState<File[]>([]);
    const [selectedMailbox, setSelectedMailbox] = useState<string | null>(null);

    // WhatsApp state
    const [selectedTemplate, setSelectedTemplate] = useState<Doc<"whatsappTemplates"> | null>(null);
    const [variableValues, setVariableValues] = useState<Record<string, string>>({});

    // Test email state
    const [showTestModal, setShowTestModal] = useState(false);
    const [showWhatsAppTestModal, setShowWhatsAppTestModal] = useState(false);
    const [isSendingTest, setIsSendingTest] = useState(false);

    // Live Review State
    const [showLivePreview, setShowLivePreview] = useState(false);

    // Send state
    const [isSending, setIsSending] = useState(false);
    const [sendComplete, setSendComplete] = useState(false);
    const [sendResults, setSendResults] = useState<{
        total: number;
        success: number;
        failed: number;
    } | null>(null);

    // Validation state
    const [showValidationErrors, setShowValidationErrors] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);

    // Queries
    const whatsappTemplates = useQuery(api.whatsappTemplates.list, {});

    // Actions
    const fetchContacts = useAction(api.actions.dynamics.fetchContacts);
    const getContactCount = useAction(api.actions.dynamics.getContactCount);
    const sendTestEmail = useAction(api.actions.email.sendTestEmail);
    const sendBulkEmails = useAction(api.actions.email.sendBulkEmails);
    const sendTestWhatsApp = useAction(api.actions.whatsapp.sendTestWhatsApp);
    const sendBulkWhatsApp = useAction(api.actions.whatsapp.sendBulkWhatsApp);

    // Build channel-appropriate filter
    const getChannelFilter = useCallback(() => {
        const odataFilter = buildODataFilter(filters);
        let channelFilter: string;

        if (campaignChannel === "email") {
            channelFilter = "emailaddress1 ne null";
        } else {
            // WhatsApp: require phone number and opt-in. Check both mobilephone and international format field
            channelFilter = "(mobilephone ne null or icon_formattedmobilenumber ne null) and riivo_whatsappoptinout eq true";
        }

        if (odataFilter) {
            return `${odataFilter} and ${channelFilter}`;
        }
        return channelFilter;
    }, [filters, campaignChannel]);

    const loadContacts = useCallback(async () => {
        try {
            setIsLoadingContacts(true);
            const channelFilter = getChannelFilter();

            const [contactsResult, countResult] = await Promise.all([
                fetchContacts({
                    filter: channelFilter,
                    search: filters.search || undefined,
                    top: 50,
                    clientType: filters.clientType || undefined,
                    entityType: filters.entityType ?? undefined,
                    bank: filters.bank ?? undefined,
                    sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                    province: filters.province || undefined,
                    ageMin: filters.ageMin ?? undefined,
                    ageMax: filters.ageMax ?? undefined,
                    ownerId: filters.ownerId || undefined,
                    industryId: filters.industryId || undefined,
                }),
                getContactCount({
                    filter: channelFilter,
                    search: filters.search || undefined,
                    clientType: filters.clientType || undefined,
                    entityType: filters.entityType ?? undefined,
                    bank: filters.bank ?? undefined,
                    sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                    province: filters.province || undefined,
                    ageMin: filters.ageMin ?? undefined,
                    ageMax: filters.ageMax ?? undefined,
                    ownerId: filters.ownerId || undefined,
                    industryId: filters.industryId || undefined,
                }),
            ]);

            setContacts(contactsResult.contacts as Contact[]);
            setTotalCount(countResult.count);
        } catch (err) {
            console.error("Failed to fetch contacts:", err);
        } finally {
            setIsLoadingContacts(false);
        }
    }, [fetchContacts, getContactCount, filters, getChannelFilter]);

    // State for select all
    const [isSelectingAll, setIsSelectingAll] = useState(false);
    const [isSelectAllActive, setIsSelectAllActive] = useState(false);
    const [virtualTotalCount, setVirtualTotalCount] = useState<number | null>(null);

    // Reload contacts when filters or step changes (only in recipients step)
    useEffect(() => {
        if (currentStep === "recipients") {
            const timer = setTimeout(() => loadContacts(), 300);
            return () => clearTimeout(timer);
        }
    }, [currentStep, filters, loadContacts]);

    // Update selected contacts when moving forward from recipients
    useEffect(() => {
        if ((currentStep === "compose" || currentStep === "preview") && !isSelectAllActive) {
            // Only update from current page if we haven't done a "Select All"
            // Note: This still has the bug of losing selections from other pages if not using Select All,
            // but fixing that fully is out of scope for this specific task.
            // For now, we ensure Select All works.
            setSelectedContacts(contacts.filter((c) => selectedIds.has(c.id)));
        }
    }, [currentStep, contacts, selectedIds, isSelectAllActive]);

    // Reset template selection when switching channels
    useEffect(() => {
        if (campaignChannel === "email") {
            setSelectedTemplate(null);
            setVariableValues({});
        }
    }, [campaignChannel]);

    const handleImageUpload = async (file: File): Promise<{ url: string; contentId: string }> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = (e.target?.result as string).split(",")[1];
                const contentId = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
                const sizeKB = Math.round(base64.length * 0.75 / 1024);

                console.log(`Image stored: ${file.name} (${sizeKB}KB)`);

                setUploadedImages((prev) => [
                    ...prev,
                    {
                        name: file.name,
                        contentType: file.type,
                        contentBase64: base64,
                    },
                ]);

                resolve({ url: `cid:${contentId}`, contentId });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    };

    const processAttachments = async (): Promise<UploadedImage[]> => {
        const processedAttachments = await Promise.all(attachments.map(file => {
            return new Promise<UploadedImage>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const base64 = (e.target?.result as string).split(",")[1];
                    resolve({
                        name: file.name,
                        contentType: file.type,
                        contentBase64: base64,
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }));

        // Mark these as not inline explicitly if we were passing that flag, but UploadedImage doesn't have it yet
        // The backend action expects { name, contentType, contentBase64, isInline? }
        // We'll merge this with uploadedImages which are implicitly inline (or we can add isInline: true to them)
        return processedAttachments;
    };

    const convertBase64ToCid = (html: string, wrapWithStyle: boolean = false): string => {
        const processed = html.replace(
            /<img([^>]*)\s+src="data:image\/[^"]+"/gi,
            (match, attrs) => {
                const contentIdMatch = attrs.match(/data-content-id="([^"]+)"/i);
                if (contentIdMatch) {
                    const contentId = contentIdMatch[1];
                    return `<img${attrs} src="cid:${contentId}"`;
                }
                return match;
            }
        );

        if (wrapWithStyle && campaignChannel === "email") {
            return `<div style="font-size: ${fontSize}; font-family: Arial, sans-serif; color: #333; line-height: 1.6; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">${processed}</div>`;
        }
        return processed;
    };

    const handleSendTest = async (email: string) => {
        setIsSendingTest(true);
        try {
            // Bake font size into HTML for test email
            const processedHtml = convertBase64ToCid(htmlContent, true);
            const fileAttachments = await processAttachments();

            // Combine inline images and file attachments
            // We need to cast to any or update UploadedImage type, but the action argument allows extra props
            const allAttachments = [
                ...uploadedImages.map(img => ({ ...img, isInline: true })),
                ...fileAttachments.map(att => ({ ...att, isInline: false }))
            ];

            const result = await sendTestEmail({
                testEmailAddress: email,
                subject,
                htmlBody: processedHtml,
                attachments: allAttachments,
                fromMailbox: selectedMailbox || undefined,
            });
            return result;
        } finally {
            setIsSendingTest(false);
        }
    };

    const handleSendWhatsAppTest = async (phoneNumber: string) => {
        if (!selectedTemplate) return { success: false, error: "No template selected" };
        setIsSendingTest(true);
        try {
            // Note: sendTestWhatsApp arguments match api.actions.whatsapp.sendTestWhatsApp
            const result = await sendTestWhatsApp({
                phoneNumber,
                templateId: selectedTemplate._id,
                variables: variableValues,
            });

            return { success: result.success, error: undefined };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : "Failed to send test message",
            };
        } finally {
            setIsSendingTest(false);
        }
    };

    const startCampaign = useMutation(api.campaignBatches.startCampaign);

    const queueBatches = useAction(api.campaignQueue.queueCampaignBatches);
    const generateUploadUrl = useMutation(api.files.generateUploadUrl);


    const handleSendCampaign = async () => {
        setShowConfirmation(true);
    };

    const confirmSend = async () => {
        setIsSending(true);
        setShowConfirmation(false);
        try {
            let recipients: { id: string; email?: string; phone?: string; name: string; variables?: string }[] = [];
            let filtersJson = undefined;

            if (isSelectAllActive) {
                // In Select All mode, we pass the filters to the backend
                // The backend will fetch contacts and create batches
                filtersJson = JSON.stringify({
                    filter: getChannelFilter(),
                    search: filters.search || undefined,
                    clientType: filters.clientType || undefined,
                    entityType: filters.entityType ?? undefined,
                    bank: filters.bank ?? undefined,
                    sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                    province: filters.province || undefined,
                    ageMin: filters.ageMin ?? undefined,
                    ageMax: filters.ageMax ?? undefined,
                    ownerId: filters.ownerId || undefined,
                    industryId: filters.industryId || undefined,
                });
            } else {
                // Standard mode: send selected recipients
                recipients = campaignChannel === "email"
                    ? selectedContacts
                        .filter((c) => c.email)
                        .map((c) => ({
                            id: c.id,
                            email: c.email!,
                            name: c.fullName,
                        }))
                    : selectedContacts
                        .filter((c) => c.internationalPhone || c.phone)
                        .map((c) => ({
                            id: c.id,
                            phone: c.internationalPhone || c.phone!,
                            name: c.fullName,
                            variables: JSON.stringify(variableValues),
                        }));
            }

            // Bake font size into HTML for bulk email
            const processedHtml = campaignChannel === "email" ? convertBase64ToCid(htmlContent, true) : undefined;

            // 1. Process attachments: upload files to Storage if present
            const backendAttachments = [];

            if (campaignChannel === "email" && attachments.length > 0) {
                // Upload files to storage first
                for (const file of attachments) {
                    const postUrl = await generateUploadUrl();
                    const result = await fetch(postUrl, {
                        method: "POST",
                        headers: { "Content-Type": file.type },
                        body: file,
                    });
                    const { storageId } = await result.json();

                    backendAttachments.push({
                        name: file.name,
                        contentType: file.type,
                        storageId: storageId,
                        isInline: false, // Explicitly not inline
                    });
                }

                const inlineImages = uploadedImages.map(img => ({ ...img, isInline: true }));
                backendAttachments.push(...inlineImages);
            } else if (campaignChannel === "email") {
                // Just inline images
                const inlineImages = uploadedImages.map(img => ({ ...img, isInline: true }));
                backendAttachments.push(...inlineImages);
            }

            // Create campaign and message records
            const campaignId = await startCampaign({
                name: campaignTitle || `${channelLabel} Campaign - ${new Date().toLocaleDateString()}`,
                channel: campaignChannel,
                recipients: isSelectAllActive ? undefined : recipients,
                filters: filtersJson, // Pass JSON stringified filters
                subject: campaignChannel === "email" ? subject : undefined,
                htmlBody: processedHtml,
                attachments: backendAttachments,
                whatsappTemplateId: campaignChannel === "whatsapp" ? selectedTemplate?._id : undefined,
                variableValues: campaignChannel === "whatsapp" ? JSON.stringify(variableValues) : undefined,
                createDynamicsActivity: true, // Always create activity for now
                fromMailbox: campaignChannel === "email" ? selectedMailbox || undefined : undefined,
            });

            // Queue batches and start processing (async - returns immediately)
            // If filters are provided, queueCampaignBatches will handle generation
            await queueBatches({
                campaignId,
                recipients: isSelectAllActive ? undefined : recipients,
                filters: filtersJson,
                channel: campaignChannel,
            });

            // Redirect to campaign detail page for progress tracking
            window.location.href = `/campaigns/${campaignId}`;
        } catch (err) {
            console.error("Failed to start campaign:", err);
            setIsSending(false);
        }
    };


    const canProceed = () => {
        switch (currentStep) {
            case "channel":
                return campaignTitle.trim() !== "";
            case "recipients":
                return selectedIds.size > 0 || isSelectAllActive;
            case "compose":
                if (campaignChannel === "email") {
                    return subject.trim() !== "" && htmlContent.trim() !== "";
                }
                return selectedTemplate !== null;
            case "preview":
                return true;
            case "send":
                return false;
            default:
                return false;
        }
    };

    const goNext = () => {
        if (!canProceed()) {
            setShowValidationErrors(true);
            return;
        }
        setShowValidationErrors(false);
        const nextIndex = stepIndex + 1;
        if (nextIndex < STEPS.length) {
            setCurrentStep(STEPS[nextIndex].id);
        }
    };

    const goPrev = () => {
        setShowValidationErrors(false);
        const prevIndex = stepIndex - 1;
        // Prevent going back to channel step
        if (prevIndex > 0) {
            setCurrentStep(STEPS[prevIndex].id);
        }
    };

    const handleVariableChange = (variable: string, value: string) => {
        setVariableValues((prev) => ({ ...prev, [variable]: value }));
    };

    const handleSelectAll = async () => {
        try {
            setIsSelectingAll(true);
            const channelFilter = getChannelFilter();

            // Get total count (we might already have it, but let's be sure)
            const countResult = await getContactCount({
                filter: channelFilter,
                search: filters.search || undefined,
                clientType: filters.clientType || undefined,
                entityType: filters.entityType ?? undefined,
                bank: filters.bank ?? undefined,
                sourceCode: filters.sourceCode.length > 0 ? filters.sourceCode : undefined,
                province: filters.province || undefined,
                ageMin: filters.ageMin ?? undefined,
                ageMax: filters.ageMax ?? undefined,
                ownerId: filters.ownerId || undefined,
                industryId: filters.industryId || undefined,
            });

            // Set select all mode active
            setIsSelectAllActive(true);

            // Clear specific selections as we are now selecting everything matching the filter
            setSelectedIds(new Set());
            setSelectedContacts([]);

            // Store the total count for display
            setVirtualTotalCount(countResult.count);

        } catch (error) {
            console.error("Failed to select all contacts:", error);
        } finally {
            setIsSelectingAll(false);
        }
    };

    const handleClearSelection = () => {
        setSelectedIds(new Set());
        setSelectedContacts([]);
        setIsSelectAllActive(false);
        setVirtualTotalCount(null);
    };

    const channelLabel = campaignChannel === "email" ? "Email" : "WhatsApp";

    // Estimated WhatsApp cost
    const whatsappRecipientCount = isSelectAllActive
        ? (virtualTotalCount || 0)
        : selectedContacts.filter((c) => c.internationalPhone || c.phone).length;
    // Assuming roughly R0.75 per message as a safe estimate, but displayed as Estimated
    const estimatedCost = ((Number(whatsappRecipientCount) || 0) * 0.75).toFixed(2);

    return (
        <>
            <Header title={`Create ${channelLabel} Campaign`} />
            <section className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    {/* Stepper */}
                    <div className="flex items-center justify-between mb-8">
                        {STEPS.map((step, idx) => (
                            <div key={step.id} className="flex items-center flex-1">
                                <button
                                    onClick={() => {
                                        // Only allow going back, not forward, and not to channel step
                                        if (idx < stepIndex && idx > 0) {
                                            setCurrentStep(step.id);
                                        }
                                    }}
                                    disabled={idx >= stepIndex || idx === 0}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${step.id === currentStep
                                        ? "bg-[#1E3A5F] text-white"
                                        : idx < stepIndex
                                            ? idx === 0
                                                ? "bg-green-100 text-green-700 cursor-default"
                                                : "bg-green-100 text-green-700 hover:bg-green-200"
                                            : "bg-gray-100 text-gray-400"
                                        }`}
                                >
                                    <step.icon size={18} />
                                    <span className="font-medium hidden md:inline">{step.label}</span>
                                </button>
                                {idx < STEPS.length - 1 && (
                                    <div
                                        className={`flex-1 h-0.5 mx-2 ${idx < stepIndex ? "bg-green-300" : "bg-gray-200"
                                            }`}
                                    />
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Navigation - Top */}
                    {!sendComplete && (
                        <div className="flex justify-between pb-2">
                            <Button
                                variant="secondary"
                                onClick={goPrev}
                                disabled={stepIndex <= 1}
                            >
                                <ArrowLeft size={16} />
                                Back
                            </Button>

                            {currentStep !== "send" && (
                                <Button onClick={goNext} disabled={false}>
                                    {currentStep === "preview" ? "Proceed to Send" : "Next"}
                                    <ArrowRight size={16} />
                                </Button>
                            )}
                        </div>
                    )}

                    {currentStep === "channel" && (
                        <div className="space-y-6">
                            {/* Mailbox selector for email channel - shown first */}
                            {campaignChannel === "email" && (
                                <Card>
                                    <div className="space-y-4">
                                        <div>
                                            <h3 className="text-lg font-bold text-gray-900">
                                                Send From
                                            </h3>
                                            <p className="text-sm text-gray-500 mt-1">
                                                Select which mailbox to send emails from
                                            </p>
                                        </div>
                                        <MailboxSelector
                                            selectedMailbox={selectedMailbox}
                                            onMailboxChange={setSelectedMailbox}
                                        />
                                    </div>
                                </Card>
                            )}

                            <Card>
                                <ChannelSelector
                                    selectedChannel={campaignChannel}
                                    onChannelChange={setCampaignChannel}
                                    campaignTitle={campaignTitle}
                                    onTitleChange={setCampaignTitle}
                                    showTitleError={showValidationErrors}
                                />
                            </Card>
                        </div>
                    )}

                    {currentStep === "recipients" && (
                        <div className="space-y-6">
                            <Card>
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h2 className="text-lg font-bold text-gray-900">
                                                Select Recipients <span className="text-red-500">*</span>
                                            </h2>
                                            <p className="text-sm text-gray-500">
                                                {campaignChannel === "whatsapp"
                                                    ? "Showing contacts with phone numbers and WhatsApp opt-in"
                                                    : "Showing contacts with valid email addresses"}
                                                {isSelectAllActive && virtualTotalCount === 5000 && (
                                                    <span className="block text-amber-600 mt-1">
                                                        Note: Count limited to 5,000 for display, but ALL matching contacts will be processed.
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            {(selectedIds.size > 0 || isSelectAllActive) && (
                                                <div className="flex flex-col items-end">
                                                    <Badge status={isSelectAllActive && virtualTotalCount === 5000 ? "warning" : "success"}>
                                                        {isSelectAllActive ? virtualTotalCount : selectedIds.size} selected
                                                        {isSelectAllActive && virtualTotalCount === 5000 && "+"}
                                                    </Badge>
                                                </div>
                                            )}
                                            {contacts.length > 0 && (
                                                <div className="flex gap-2">
                                                    <Button
                                                        variant="secondary"
                                                        onClick={handleSelectAll}
                                                        disabled={
                                                            isSelectAllActive ||
                                                            (selectedIds.size === contacts.length && contacts.length === totalCount) ||
                                                            isSelectingAll
                                                        }
                                                    >
                                                        {isSelectingAll ? (
                                                            <>
                                                                <Loader2 size={16} className="animate-spin" />
                                                                Selecting...
                                                            </>
                                                        ) : (
                                                            `Select All (${totalCount ?? contacts.length})`
                                                        )}
                                                    </Button>
                                                    {(selectedIds.size > 0 || isSelectAllActive) && (
                                                        <Button
                                                            variant="secondary"
                                                            onClick={handleClearSelection}
                                                        >
                                                            Clear
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {showValidationErrors && selectedIds.size === 0 && !isSelectAllActive && (
                                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                                            <p className="text-sm text-red-600 font-medium">
                                                Please select at least one recipient to continue, or use "Select All" to send to everyone.
                                            </p>
                                        </div>
                                    )}

                                    <ContactFilters
                                        filters={filters}
                                        onFiltersChange={setFilters}
                                        totalCount={totalCount}
                                    />
                                </div>
                            </Card>

                            <ContactList
                                contacts={contacts}
                                isLoading={isLoadingContacts && contacts.length === 0}
                                selectedIds={selectedIds}
                                onSelectionChange={setSelectedIds}
                                showSelection={true}
                            />
                        </div>
                    )}

                    {currentStep === "compose" && (
                        <>
                            {campaignChannel === "email" ? (
                                <div className="space-y-6">
                                    <Card title="Email Content">
                                        <EmailComposer
                                            subject={subject}
                                            onSubjectChange={setSubject}
                                            htmlContent={htmlContent}
                                            onContentChange={setHtmlContent}
                                            fontSize={fontSize}
                                            onFontSizeChange={setFontSize}
                                            onImageUpload={handleImageUpload}
                                            attachments={attachments}
                                            onAttachmentsChange={setAttachments}
                                            onPreview={() => setShowLivePreview(true)}
                                        />
                                    </Card>

                                    <LivePreviewModal
                                        isOpen={showLivePreview}
                                        onClose={() => setShowLivePreview(false)}
                                        subject={subject}
                                        htmlContent={convertBase64ToCid(htmlContent, true)} // Preview with styles
                                        senderEmail={selectedMailbox || undefined}
                                        recipientName={selectedContacts[0]?.fullName || "Recipient Name"}
                                        recipientEmail={selectedContacts[0]?.email || "recipient@example.com"}
                                        attachments={attachments}
                                    />
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    <Card title="Select Template">
                                        <TemplateSelector
                                            templates={whatsappTemplates || []}
                                            selectedTemplateId={selectedTemplate?._id || null}
                                            onSelectTemplate={setSelectedTemplate}
                                            variableValues={variableValues}
                                            onVariableChange={handleVariableChange}
                                        />
                                    </Card>

                                    <Card title="Message Preview">
                                        <WhatsAppPreview
                                            template={selectedTemplate}
                                            variableValues={variableValues}
                                            recipientName={selectedContacts[0]?.fullName}
                                            recipientPhone={selectedContacts[0]?.phone || undefined}
                                        />
                                    </Card>
                                </div>
                            )}
                        </>
                    )}

                    {currentStep === "preview" && (
                        <div className="space-y-6">
                            <Card title="Campaign Summary">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                                    <div className="p-4 bg-blue-50 rounded-lg">
                                        <div className="text-3xl font-bold text-[#1E3A5F]">
                                            {campaignChannel === "email"
                                                ? selectedContacts.filter((c) => c.email).length
                                                : whatsappRecipientCount}
                                        </div>
                                        <div className="text-sm text-gray-600">Recipients</div>
                                    </div>
                                    <div className="p-4 bg-purple-50 rounded-lg">
                                        <div className="text-lg font-semibold text-purple-700 capitalize">
                                            {campaignChannel}
                                        </div>
                                        <div className="text-sm text-gray-600">Channel</div>
                                    </div>
                                    {campaignChannel === "email" ? (
                                        <>
                                            <div className="p-4 bg-green-50 rounded-lg">
                                                <div className="text-lg font-semibold text-green-700 truncate">
                                                    {subject || "(No subject)"}
                                                </div>
                                                <div className="text-sm text-gray-600">Subject Line</div>
                                            </div>
                                            <div className="p-4 bg-amber-50 rounded-lg">
                                                <div className="text-lg font-semibold text-amber-700">
                                                    {uploadedImages.length} images
                                                </div>
                                                <div className="text-sm text-gray-600">Attachments</div>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="p-4 bg-green-50 rounded-lg col-span-1">
                                                <div className="text-lg font-semibold text-green-700 truncate">
                                                    {selectedTemplate?.name || "(No template)"}
                                                </div>
                                                <div className="text-sm text-gray-600">Template</div>
                                            </div>
                                            <div className="p-4 bg-emerald-50 rounded-lg col-span-1 border border-emerald-100">
                                                <div className="flex items-center gap-1.5 text-lg font-semibold text-emerald-700">
                                                    <span className="text-sm">R</span>
                                                    <span>{estimatedCost}</span>
                                                </div>
                                                <div className="text-sm text-emerald-600 flex items-center gap-1">
                                                    Estimated Cost
                                                    <AlertTriangle size={12} className="text-emerald-500" />
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </Card>

                            <Card title="Final Preview">
                                {campaignChannel === "email" ? (
                                    <EmailPreview
                                        subject={subject}
                                        htmlContent={htmlContent}
                                        senderEmail={selectedMailbox || undefined}
                                        recipientName={selectedContacts[0]?.fullName}
                                        recipientEmail={selectedContacts[0]?.email || undefined}
                                        attachments={attachments}
                                    />
                                ) : (
                                    <WhatsAppPreview
                                        template={selectedTemplate}
                                        variableValues={variableValues}
                                        recipientName={selectedContacts[0]?.fullName}
                                        recipientPhone={selectedContacts[0]?.phone || undefined}
                                    />
                                )}
                            </Card>

                            {campaignChannel === "email" && (
                                <Card className="border-amber-200 bg-amber-50">
                                    <div className="flex items-center gap-3">
                                        <TestTube className="text-amber-600" size={24} />
                                        <div className="flex-1">
                                            <h4 className="font-semibold text-amber-800">
                                                Send a test email first
                                            </h4>
                                            <p className="text-sm text-amber-700">
                                                We recommend testing before sending to all recipients
                                            </p>
                                        </div>
                                        <Button variant="secondary" onClick={() => setShowTestModal(true)}>
                                            <TestTube size={16} />
                                            Send Test
                                        </Button>
                                    </div>
                                </Card>
                            )}

                            {campaignChannel === "whatsapp" && (
                                <Card className="border-amber-200 bg-amber-50">
                                    <div className="flex items-center gap-3">
                                        <AlertTriangle className="text-amber-600" size={24} />
                                        <div className="flex-1">
                                            <h4 className="font-semibold text-amber-800">
                                                WhatsApp Message Costs
                                            </h4>
                                            <p className="text-sm text-amber-700">
                                                Marketing messages may incur costs per message. Check your
                                                Meta Business Suite for pricing details.
                                            </p>
                                        </div>
                                        <Button variant="secondary" onClick={() => setShowWhatsAppTestModal(true)}>
                                            <MessageSquare size={16} />
                                            Send Test
                                        </Button>
                                    </div>
                                </Card>
                            )}
                        </div>
                    )}

                    {currentStep === "send" && (
                        <div className="space-y-6">
                            {!sendComplete ? (
                                <Card>
                                    <div className="text-center py-8 space-y-6">
                                        <div className={`w-16 h-16 ${campaignChannel === "email" ? "bg-[#1E3A5F]" : "bg-green-600"} text-white rounded-full flex items-center justify-center mx-auto`}>
                                            {campaignChannel === "email" ? <Mail size={32} /> : <MessageSquare size={32} />}
                                        </div>
                                        <div>
                                            <h2 className="text-2xl font-bold text-gray-900">
                                                Ready to Send?
                                            </h2>
                                            <p className="text-gray-500 mt-2">
                                                You&apos;re about to send this {channelLabel.toLowerCase()} to{" "}
                                                <strong>
                                                    {isSelectAllActive
                                                        ? virtualTotalCount
                                                        : campaignChannel === "email"
                                                            ? selectedContacts.filter((c) => c.email).length
                                                            : whatsappRecipientCount}
                                                </strong>{" "}
                                                recipients.
                                            </p>
                                        </div>
                                        <Button
                                            onClick={handleSendCampaign}
                                            disabled={isSending}
                                            className="px-8 py-3 text-lg"
                                        >
                                            {isSending ? (
                                                <>
                                                    <Loader2 size={20} className="animate-spin" />
                                                    Sending...
                                                </>
                                            ) : (
                                                <>
                                                    <Send size={20} />
                                                    Send Campaign
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </Card>
                            ) : (
                                <Card>
                                    <div className="text-center py-8 space-y-6">
                                        <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                                            <CheckCircle size={32} />
                                        </div>
                                        <div>
                                            <h2 className="text-2xl font-bold text-gray-900">
                                                Campaign Sent!
                                            </h2>
                                            <p className="text-gray-500 mt-2">
                                                Your {channelLabel.toLowerCase()} campaign has been sent successfully.
                                            </p>
                                        </div>
                                        {sendResults && (
                                            <div className="flex justify-center gap-8">
                                                <div className="text-center">
                                                    <div className="text-3xl font-bold text-green-600">
                                                        {sendResults.success}
                                                    </div>
                                                    <div className="text-sm text-gray-500">Delivered</div>
                                                </div>
                                                {sendResults.failed > 0 && (
                                                    <div className="text-center">
                                                        <div className="text-3xl font-bold text-red-600">
                                                            {sendResults.failed}
                                                        </div>
                                                        <div className="text-sm text-gray-500">Failed</div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <Button
                                            variant="secondary"
                                            onClick={() => (window.location.href = "/monitoring")}
                                        >
                                            View Campaign Details
                                        </Button>
                                    </div>
                                </Card>
                            )}
                        </div>
                    )}
                </div>
            </section>

            {/* Test Email Modal */}
            <TestEmailModal
                isOpen={showTestModal}
                onClose={() => setShowTestModal(false)}
                onSendTest={handleSendTest}
                subject={subject}
                isSending={isSendingTest}
            />

            {/* Test WhatsApp Modal */}
            <TestWhatsAppModal
                isOpen={showWhatsAppTestModal}
                onClose={() => setShowWhatsAppTestModal(false)}
                onSendTest={handleSendWhatsAppTest}
                templateName={selectedTemplate?.name || ""}
                isSending={isSendingTest}
            />

            <ConfirmationModal
                isOpen={showConfirmation}
                onClose={() => setShowConfirmation(false)}
                onConfirm={confirmSend}
                title="Send Campaign?"
                description={`Are you sure you want to send this ${channelLabel.toLowerCase()} campaign to ${isSelectAllActive ? virtualTotalCount : (campaignChannel === "email" ? selectedContacts.filter((c) => c.email).length : whatsappRecipientCount)} recipients? This action cannot be undone once processing starts.`}
                confirmLabel="Yes, Send Campaign"
                cancelLabel="Cancel"
                isLoading={isSending}
                variant="warning"
            />
        </>
    );
}
