# TTT Communication Tool - User Guide

Welcome to the TTT Communication Tool! This guide helps you navigate the platform to create, manage, and track your communication campaigns effectively.

## 1. Introduction

The TTT Communication Tool is designed to streamline your communication efforts by integrating directly with Dynamics 365.

**Key Benefits:**
*   **Multi-Channel Support:** Send both Email and WhatsApp campaigns from a single platform.
*   **Dynamics 365 Integration:** Directly access your CRM contacts without manual exports.
*   **Real-Time Tracking:** Monitor delivery rates, failures, and engagement instantly.

## 2. Getting Started

### Accessing the Dashboard
Upon logging in, you are greeted by the Dashboard. This is your command center.

*   **Quick Stats:** See "Sent this Month", "Avg Delivery Rate", "Failed Messages", and "Total Campaigns" at a glance.
*   **Trends:** The "Delivery Trends" chart shows your activity over the last 14 days.
*   **Recent Campaigns:** Quickly access your most recent campaigns and their status.

## 3. Campaign Management

### Creating a New Campaign

1.  **Navigate to Create**: Click the **New Campaign** button on the Dashboard or Sidebar.
2.  **Step 1: Setup**
    *   **Name**: Give your campaign a descriptive name.
    *   **Channel**: Select **Email** or **WhatsApp**.
3.  **Step 2: Audience**
    *   Use the **Dynamics 365 Filters** to select your recipients.
    *   Filter by *Client Type*, *Entity Type*, *Province*, and more.
    *   The "Total Recipients" count updates automatically as you filter.
4.  **Step 3: Content**
    *   **For Email**: Use the rich text editor to compose your message. You can add images and format text.
    *   **For WhatsApp**: Select a pre-approved template from the list.
5.  **Step 4: Review & Send**
    *   Review your settings and audience count.
    *   Click **Send Campaign** to launch immediately or schedule it for later (if enabled).

### Monitoring Status

Your campaigns can have the following statuses:
*   **Processing**: The system is preparing the messages.
*   **Queued**: Messages are waiting to be sent.
*   **Completed**: All messages have been sent.
*   **Failed**: The campaign encountered issues.

## 4. Templates (WhatsApp)

WhatsApp messages require pre-approved templates from Meta.
*   **Sync**: Templates are synced from your Meta Business Account.
*   **Approval**: only `Approved` templates can be used in campaigns.
*   **Variables**: Templates may support dynamic variables (e.g., `{{1}}` for First Name) to personalize messages.

## 5. Analytics & Reporting

Click on any campaign in the "Campaigns" list to view its detailed report.
*   **Delivery Rate**: Percentage of messages successfully delivered.
*   **Failure Reasons**: Detailed logs on why specific messages failed (e.g., invalid number, bounced email).
*   **CRM Logs**: All communications are automatically logged back to the contact's activity timeline in Dynamics 365.

## 6. Access & Permissions

*   **Admin**: Full access to all features, including user management and settings.
*   **User**: Access to create and manage campaigns.

---
*Need help? Contact your system administrator for support.*
