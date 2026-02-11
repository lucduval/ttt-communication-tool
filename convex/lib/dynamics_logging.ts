/**
 * Dynamics 365 CRM Logging Helpers
 * Writes email and WhatsApp communication records to Dynamics for audit trails.
 */

import { dynamicsRequest } from "./dynamics_auth";

/**
 * Log an email activity to Dynamics 365 (creates an 'email' activity record).
 * @returns The email activity ID if successful
 */
export async function logEmailActivity(
    contactId: string,
    subject: string,
    body: string
): Promise<string | undefined> {
    try {
        const emailActivity = {
            subject: subject,
            description: body.replace(/<[^>]*>/g, "").substring(0, 2000), // Strip HTML, limit length
            directioncode: true, // Outgoing
            "regardingobjectid_contact@odata.bind": `/contacts(${contactId})`,
            actualdurationminutes: 1,
            statuscode: 2, // Sent
            statecode: 1, // Completed
        };

        const response = await dynamicsRequest<{ emailid: string }>("emails", {
            method: "POST",
            body: JSON.stringify(emailActivity),
        });

        return response.emailid;
    } catch (err) {
        console.error(`Failed to log email activity for contact ${contactId}:`, err);
        return undefined;
    }
}

/**
 * Log a WhatsApp communication to Dynamics 365 (creates a 'riivo_whatsappcommunicationses' activity record).
 * @returns The activity ID if successful
 */
export async function logWhatsAppActivity(
    contactId: string,
    templateName: string,
    messageContent: string
): Promise<string | undefined> {
    try {
        const whatsAppActivity = {
            subject: `WhatsApp: ${templateName}`,
            description: messageContent.substring(0, 2000),
            "regardingobjectid_contact@odata.bind": `/contacts(${contactId})`,
            statuscode: 1, // Open
            statecode: 0,  // Open
        };

        const response = await dynamicsRequest<{ activityid: string }>(
            "riivo_whatsappcommunicationses",
            {
                method: "POST",
                body: JSON.stringify(whatsAppActivity),
            }
        );

        return response.activityid;
    } catch (err) {
        console.error(`Failed to log WhatsApp activity for contact ${contactId}:`, err);
        return undefined;
    }
}

/**
 * Unsubscribe a contact from email marketing in Dynamics 365.
 * Sets icon_sendemailclientnotifications to false.
 */
export async function unsubscribeContact(contactId: string): Promise<boolean> {
    try {
        await dynamicsRequest(`contacts(${contactId})`, {
            method: "PATCH",
            body: JSON.stringify({
                icon_sendemailclientnotifications: false,
            }),
        });
        return true;
    } catch (err) {
        console.error(`Failed to unsubscribe contact ${contactId}:`, err);
        return false;
    }
}
