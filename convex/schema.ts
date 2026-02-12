import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    campaigns: defineTable({
        name: v.string(),
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
        status: v.string(), // draft, queued, processing, completed, paused, failed
        subject: v.optional(v.string()),
        content: v.optional(v.string()),
        templateId: v.optional(v.string()),
        filterCriteria: v.optional(v.string()), // OData filter stored as JSON
        filters: v.optional(v.string()), // New filter object stored as JSON for backend fetching
        totalRecipients: v.number(),
        sentCount: v.number(),
        deliveredCount: v.number(),
        failedCount: v.number(),
        createdBy: v.string(), // Clerk user ID
        scheduledAt: v.optional(v.number()),
        // Batch processing fields
        currentBatch: v.optional(v.number()),
        totalBatches: v.optional(v.number()),
        // Email content (stored for batch processing)
        htmlBody: v.optional(v.string()),
        attachments: v.optional(v.array(v.object({
            name: v.string(),
            contentType: v.string(),
            contentBase64: v.optional(v.string()),
            storageId: v.optional(v.id("_storage")),
            isInline: v.optional(v.boolean()),
        }))),
        // WhatsApp template reference for batch processing
        whatsappTemplateId: v.optional(v.id("whatsappTemplates")),
        variableValues: v.optional(v.string()), // JSON stringified variables
        createDynamicsActivity: v.optional(v.boolean()),
        // Selected sender mailbox for email campaigns
        fromMailbox: v.optional(v.string()),
    })
        .index("by_status", ["status"])
        .index("by_user", ["createdBy"])
        .searchIndex("search_name", {
            searchField: "name",
        }),

    // Batch queue for processing large campaigns
    campaignBatches: defineTable({
        campaignId: v.id("campaigns"),
        batchNumber: v.number(),
        totalBatches: v.number(),
        status: v.string(), // pending, processing, completed, failed
        recipients: v.array(v.object({
            id: v.string(),
            email: v.optional(v.string()),
            phone: v.optional(v.string()),
            name: v.string(),
            variables: v.optional(v.string()), // JSON stringified
        })),
        processedCount: v.number(),
        successCount: v.number(),
        failedCount: v.number(),
        startedAt: v.optional(v.number()),
        completedAt: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
    })
        .index("by_campaign", ["campaignId"])
        .index("by_campaign_status", ["campaignId", "status"])
        .index("by_status", ["status"]),

    messages: defineTable({
        campaignId: v.id("campaigns"),
        recipientId: v.string(), // Dynamics contact/account ID
        recipientEmail: v.optional(v.string()),
        recipientPhone: v.optional(v.string()),
        recipientName: v.string(),
        status: v.string(), // pending, queued, sent, delivered, failed
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
        errorMessage: v.optional(v.string()),
        dynamicsActivityId: v.optional(v.string()),
        externalMessageId: v.optional(v.string()), // Graph/Twilio ID
        sentAt: v.optional(v.number()),
        deliveredAt: v.optional(v.number()),
    })
        .index("by_campaign", ["campaignId"])
        .index("by_campaign_recipient", ["campaignId", "recipientId"])
        .index("by_status", ["status"])
        .index("by_external_id", ["externalMessageId"]),

    // WhatsApp templates (manually added from Meta Business Suite)
    whatsappTemplates: defineTable({
        name: v.string(),
        metaTemplateId: v.string(), // Template ID/name from Meta Business Suite
        category: v.string(), // marketing, utility, authentication
        status: v.string(), // pending, approved, rejected
        body: v.string(),
        variables: v.array(v.string()), // List of variable placeholders
        variableMappings: v.optional(v.string()), // JSON stringified mapping of placeholder -> logical field
        language: v.string(),
        // Header support
        headerType: v.optional(v.string()), // none, text, image, document, video
        headerText: v.optional(v.string()), // For text headers
        headerUrl: v.optional(v.string()), // For media headers (image, document, video)
        lastUpdatedAt: v.number(),
    })
        .index("by_status", ["status"])
        .index("by_meta_id", ["metaTemplateId"]),

    // Authorized users for the application
    users: defineTable({
        clerkId: v.optional(v.string()), // Optional because invited users might not have signed up yet
        email: v.string(),
        name: v.optional(v.string()),
        role: v.union(v.literal("admin"), v.literal("user")),
        status: v.string(), // active, inactive
        invitedBy: v.optional(v.string()), // ID of user who invited
        joinedAt: v.optional(v.number()),
        lastLoginAt: v.optional(v.number()),
    })
        .index("by_clerk_id", ["clerkId"])
        .index("by_email", ["email"]),

    // User invitations
    invitations: defineTable({
        email: v.string(),
        token: v.string(),
        role: v.union(v.literal("admin"), v.literal("user")),
        invitedBy: v.string(), // ID of user who invited
        status: v.string(), // pending, accepted, expired, revoked
        expiresAt: v.number(),
        acceptedAt: v.optional(v.number()),
        acceptedBy: v.optional(v.string()), // Clerk user ID
    })
        .index("by_email", ["email"])
        .index("by_token", ["token"])
        .index("by_status", ["status"]),

    // Notifications for users
    notifications: defineTable({
        userId: v.string(), // Clerk user ID
        title: v.string(),
        message: v.string(),
        type: v.string(), // info, success, warning, error
        isRead: v.boolean(),
        link: v.optional(v.string()), // URL to navigate to
        createdAt: v.number(),
    })
        .index("by_user", ["userId"])
        .index("by_user_unread", ["userId", "isRead"]),
});

