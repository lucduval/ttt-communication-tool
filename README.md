# TTT Communication Tool

A comprehensive communication management platform designed to streamline Email and WhatsApp campaigns.

## Overview

The TTT Communication Tool allows administrators to create, manage, and track communication campaigns across multiple channels (Email and WhatsApp). It integrates with Dynamics 365 for contact management and logging, ensuring a seamless flow of data between your CRM and communication efforts.

## Key Features

-   **Multi-Channel Campaigns**: Create and send campaigns via Email and WhatsApp.
-   **Dynamics 365 Integration**: Fetch contacts directly from Dynamics 365 with advanced filtering (Client Type, Entity Type, Province, etc.) and log all communications back to the CRM.
-   **Interactive Dashboard**: Real-time insights into campaign performance, including delivery rates, failure tracking, and recent activity.
-   **User Management**: Role-based access control (Admin/User) to manage team members securely.
-   **Rich Email Editor**: Compose responsive HTML emails with image uploads and live preview.
-   **WhatsApp Templates**: Send approved WhatsApp templates with dynamic variable substitution.
-   **Responsive Design**: Fully optimized for both desktop and mobile devices.

## Tech Stack

-   **Frontend**: Next.js 14 (App Router), Tailwind CSS, Lucide React
-   **Backend**: Convex (Real-time database and serverless functions)
-   **Authentication**: Clerk
-   **Integrations**:
    -   Dynamics 365 (Web API)
    -   Clickatell (WhatsApp)
    -   SendGrid / SMTP (Email)

## Getting Started

1.  **Clone the repository**
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Run the development server**:
    ```bash
    npm run dev
    ```
4.  **Run Convex**:
    ```bash
    npx convex dev
    ```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
