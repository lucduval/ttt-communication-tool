/**
 * Microsoft Graph API client for sending emails
 * Uses client credentials flow (service principal)
 */

interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

let cachedGraphToken: { token: string; expiresAt: number } | null = null;

/**
 * Get an access token for Microsoft Graph API
 */
export async function getGraphAccessToken(): Promise<string> {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        throw new Error(
            "Missing required environment variables for Graph API: AZURE_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET"
        );
    }

    // Check if we have a valid cached token (with 5-minute buffer)
    if (cachedGraphToken && cachedGraphToken.expiresAt > Date.now() + 5 * 60 * 1000) {
        return cachedGraphToken.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to acquire Graph token: ${response.status} - ${errorText}`);
    }

    const data: TokenResponse = await response.json();

    // Cache the token
    cachedGraphToken = {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
}

export interface EmailAttachment {
    name: string;
    contentType: string;
    contentBase64: string; // Base64 encoded content
    isInline?: boolean;
}

export interface EmailMessage {
    subject: string;
    body: string; // HTML content
    toRecipients: Array<{ email: string; name?: string }>;
    ccRecipients?: Array<{ email: string; name?: string }>;
    attachments?: EmailAttachment[];
    importance?: "low" | "normal" | "high";
    saveToSentItems?: boolean;
    fromMailbox?: string; // Optional: specific shared mailbox to send from
}

/**
 * Send an email using Microsoft Graph API from a shared mailbox
 * @param message - Email message with optional fromMailbox override
 */
export async function sendEmail(message: EmailMessage): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // Use explicitly provided mailbox, or fall back to default from env
    const sharedMailbox = message.fromMailbox || process.env.SHARED_MAILBOX_ADDRESS;

    if (!sharedMailbox) {
        throw new Error("No mailbox specified and SHARED_MAILBOX_ADDRESS is not configured");
    }

    const token = await getGraphAccessToken();

    // Build the email payload
    const emailPayload: Record<string, unknown> = {
        message: {
            subject: message.subject,
            body: {
                contentType: "HTML",
                content: message.body,
            },
            toRecipients: message.toRecipients.map((r) => ({
                emailAddress: {
                    address: r.email,
                    name: r.name || r.email,
                },
            })),
            importance: message.importance || "normal",
        },
        saveToSentItems: message.saveToSentItems !== false,
    };

    // Add CC recipients if provided
    if (message.ccRecipients && message.ccRecipients.length > 0) {
        (emailPayload.message as Record<string, unknown>).ccRecipients = message.ccRecipients.map((r) => ({
            emailAddress: {
                address: r.email,
                name: r.name || r.email,
            },
        }));
    }

    // Add attachments if provided (for inline images)
    if (message.attachments && message.attachments.length > 0) {
        (emailPayload.message as Record<string, unknown>).attachments = message.attachments.map((att) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.name,
            contentType: att.contentType,
            contentBytes: att.contentBase64,
            isInline: att.isInline !== undefined ? att.isInline : att.contentType.startsWith("image/"),
            contentId: att.name.replace(/\.[^.]+$/, ""), // Remove extension for contentId
        }));
    }

    // Send email from shared mailbox
    const url = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/sendMail`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(emailPayload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Graph API error:", response.status, errorText);
        return {
            success: false,
            error: `Failed to send email: ${response.status} - ${errorText}`,
        };
    }

    return {
        success: true,
    };
}

/**
 * Upload an inline image and get its content ID for embedding in HTML
 */
export function createInlineImageHtml(imageName: string, altText: string): string {
    const contentId = imageName.replace(/\.[^.]+$/, "");
    return `<img src="cid:${contentId}" alt="${altText}" style="max-width: 100%; height: auto;" />`;
}
