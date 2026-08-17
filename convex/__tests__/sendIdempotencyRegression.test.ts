/**
 * Headline send-path idempotency regression test (PRD #55, slice #62).
 *
 * This is the capstone that proves the reported duplicate-send bug can never
 * silently return. It wires the REAL pieces of the at-most-once seam together
 * end-to-end against a stateful in-memory `ctx`:
 *   - the Channel Send driver (`runChannelSend`)
 *   - the REAL email adapter (`emailSender`) with only the Graph `$batch`
 *     boundary faked, so per-recipient `X-Recipient-ID` headers and the
 *     terminal-failed settling (issue #57) are exercised for real
 *   - the REAL idempotent `attempted` upsert (`markAttemptedBatchImpl`)
 *   - the REAL eligibility rule (`eligibleRecipients`, via the driver)
 *   - the REAL recover-stuck-batches sweep (`recoverStuckBatchesImpl`)
 *
 * The two scenarios mirror issue #62's acceptance criteria:
 *   1. An *ambiguous* Graph response — a `$batch` sub-request returns 429 while
 *      the message actually delivered — settles the recipient terminal `failed`
 *      with no in-call resend, and a subsequent batch-recovery re-run sends
 *      ZERO duplicates for that recipient.
 *   2. The recover-stuck-batches sweep still functions: a genuinely-dead
 *      `processing` batch is recovered to `pending`, a worker is re-scheduled,
 *      and the re-run *completes* the genuinely-unfinished work (a recipient
 *      that was never handed to Graph before the crash) — without duplicating
 *      any already-handled recipient.
 *
 * Clock and Graph client are injected; no live mailbox or real wall-clock wait.
 *
 * A note on the "crash": a batch only ends up stuck in `processing` when the
 * Convex action is *killed uncatchably* mid-batch (timeout/OOM). Every catchable
 * throw ends the batch `failed` (see the driver's catch → handleBatchError), and
 * a `failed` batch is never re-run — only a stuck `processing` batch is, via the
 * sweep. That uncatchable kill cannot be produced by control flow, so the
 * post-crash DB state is set up directly; the durable per-recipient writes that
 * survive it (flush-every-25) are exactly what the seam relies on. The recovery
 * and re-run themselves run entirely through the real driver + real sweep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFunctionName } from "convex/server";

const boundary = vi.hoisted(() => ({
    sendEmailBatch: vi.fn(),
    // WhatsApp file-as-source boundary (issue #70): the Meta send, the per-recipient
    // media upload, and the Tina notify are all faked so no real network is hit.
    sendTemplateWithRetry: vi.fn(),
    uploadWhatsAppMedia: vi.fn(),
    notifyTinaOfOutboundTemplate: vi.fn(),
    logWhatsAppActivity: vi.fn(),
}));

vi.mock("../lib/graph_client", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, sendEmailBatch: boundary.sendEmailBatch };
});

vi.mock("../lib/whatsapp", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return {
        ...actual,
        getMetaWhatsAppConfig: () => ({
            token: "tok",
            phoneNumberId: "pnid",
            graphApiVersion: "v22.0",
            sendUrl: "https://graph.test/messages",
            maxSendPerSecond: 1000,
            maxConcurrent: 1,
            retryMaxAttempts: 5,
            retryBaseDelayMs: 1,
            dailyTierLimit: 100000,
        }),
        sendTemplateWithRetry: boundary.sendTemplateWithRetry,
        uploadWhatsAppMedia: boundary.uploadWhatsAppMedia,
    };
});

vi.mock("../lib/notifyTina", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return { ...actual, notifyTinaOfOutboundTemplate: boundary.notifyTinaOfOutboundTemplate };
});

vi.mock("../lib/dynamics_logging", () => ({
    logWhatsAppActivity: boundary.logWhatsAppActivity,
    logEmailActivity: vi.fn(),
}));

import { emailSender, whatsappSender } from "../channelSenders";
import { runChannelSend } from "../lib/channelSend";
import { markAttemptedBatchImpl } from "../messages";
import { recoverStuckBatchesImpl } from "../campaignBatches";
import { LEASE_MS } from "../lib/batchLease";

// ---------------------------------------------------------------------------
// Stateful in-memory harness. One `ctx` exposes both `db` (for the sweep) and
// `runQuery`/`runMutation`/`scheduler` (for the driver + adapter), backed by the
// same tables so a write through the driver is visible to the sweep and vice
// versa. Dispatch calls the REAL impls where they exist (markAttemptedBatchImpl)
// and faithfully mirrors the remaining handlers' bodies.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function makeHarness(now: () => number) {
    const tables: Record<string, Row[]> = {
        campaigns: [],
        campaignBatches: [],
        messages: [],
        invoicePdfs: [],
        whatsappTemplates: [],
    };
    let seq = 0;

    const findById = (id: string): Row | undefined => {
        for (const t of Object.values(tables)) {
            const row = t.find((r) => r._id === id);
            if (row) return row;
        }
        return undefined;
    };

    const db = {
        get: async (id: string) => findById(id) ?? null,
        insert: async (table: string, doc: Row) => {
            const _id = `${table}:${seq++}`;
            tables[table].push({ _id, ...doc });
            return _id;
        },
        patch: async (id: string, fields: Row) => {
            const row = findById(id);
            if (row) Object.assign(row, fields);
        },
        query: (table: string) => ({
            withIndex: (_index: string, fn?: (q: any) => any) => {
                const constraints: Record<string, unknown> = {};
                const q = {
                    eq: (field: string, value: unknown) => {
                        constraints[field] = value;
                        return q;
                    },
                };
                if (fn) fn(q);
                const rows = tables[table].filter((r) =>
                    Object.entries(constraints).every(([k, v]) => r[k] === v)
                );
                return {
                    first: async () => rows[0] ?? null,
                    collect: async () => rows.slice(),
                    take: async (n: number) => rows.slice(0, n),
                };
            },
        }),
    };

    // Faithful mirrors of the internal query/mutation handlers the driver calls.
    // recomputeCampaignStats is deliberately omitted from markBatchComplete/Failed
    // here — it is orthogonal to the idempotency invariant under test and lives in
    // campaignTally, which carries unrelated WIP. The batch/campaign status
    // transitions and `hasMoreBatches` are what the driver's control flow depends
    // on, and those are mirrored exactly.
    const noPending = async (campaignId: string, status: string) =>
        !(await db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q: any) =>
                q.eq("campaignId", campaignId).eq("status", status)
            )
            .first());

    const ctx: any = {
        db,
        runQuery: vi.fn(async (ref: unknown, args: any) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return db.get(args.campaignId);
                case "campaignBatches:getNextPendingBatchInternal":
                    return db
                        .query("campaignBatches")
                        .withIndex("by_campaign_status", (q: any) =>
                            q.eq("campaignId", args.campaignId).eq("status", "pending")
                        )
                        .first();
                case "campaignBatches:getCampaignContent":
                    return { htmlBody: "<p>Hi {firstName}</p>", fontSize: "15px", attachments: [] };
                case "invoicePdfs:getGeneratedPdfRefs":
                    // Mirror the real query: one ref per `generated` row, with the
                    // stored file size (fixed here) the chunker's byte budget needs.
                    return tables.invoicePdfs
                        .filter((r) => r.campaignId === args.campaignId && r.status === "generated")
                        .map((r) => ({ recipientId: r.recipientId, storageId: r.storageId, size: 1024 }));
                case "files:getDownloadUrlInternal":
                    // A stable fake URL per storageId; the stubbed fetch serves bytes for it.
                    return `https://storage.test/${args.storageId}`;
                case "campaignBatches:getWhatsAppTemplate":
                    return db.get(args.templateId);
                case "invoicePdfs:getWhatsAppPdfRefs":
                    // Mirror the real query: one ref per `generated` row, carrying any
                    // cached Meta media id so a re-run can skip the re-upload.
                    return tables.invoicePdfs
                        .filter((r) => r.campaignId === args.campaignId && r.status === "generated")
                        .map((r) => ({
                            recipientId: r.recipientId,
                            storageId: r.storageId,
                            whatsappMediaId: r.whatsappMediaId,
                            whatsappMediaIdUploadedAt: r.whatsappMediaIdUploadedAt,
                        }));
                case "messages:getExistingMessageStatuses": {
                    const rows: Array<{ recipientId: string; status: string }> = [];
                    for (const recipientId of args.recipientIds) {
                        const msg = await db
                            .query("messages")
                            .withIndex("by_campaign_recipient", (q: any) =>
                                q.eq("campaignId", args.campaignId).eq("recipientId", recipientId)
                            )
                            .first();
                        if (msg) rows.push({ recipientId, status: msg.status });
                    }
                    return rows;
                }
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            const name = getFunctionName(ref as any);
            switch (name) {
                case "campaignBatches:markBatchProcessing": {
                    const batch = await db.get(args.batchId);
                    if (!batch) return { acquired: false };
                    if (batch.status !== "pending") return { acquired: false };
                    const claimedAt = now();
                    await db.patch(args.batchId, {
                        status: "processing",
                        startedAt: claimedAt,
                        heartbeatAt: claimedAt,
                    });
                    return { acquired: true };
                }
                case "campaignBatches:beatBatch":
                    await db.patch(args.batchId, { heartbeatAt: now() });
                    return undefined;
                case "campaignBatches:markBatchComplete": {
                    const batch = await db.get(args.batchId);
                    if (!batch) return { hasMoreBatches: false };
                    await db.patch(args.batchId, {
                        status: "completed",
                        completedAt: now(),
                        processedCount: args.successCount + args.failedCount,
                        successCount: args.successCount,
                        failedCount: args.failedCount,
                    });
                    const hasPending = !(await noPending(batch.campaignId, "pending"));
                    const hasProcessing = !(await noPending(batch.campaignId, "processing"));
                    if (!hasPending && !hasProcessing) {
                        await db.patch(batch.campaignId, { status: "completed" });
                    }
                    return { hasMoreBatches: hasPending };
                }
                case "campaignBatches:markBatchFailed": {
                    const batch = await db.get(args.batchId);
                    if (!batch) return { hasMoreBatches: false };
                    await db.patch(args.batchId, {
                        status: "failed",
                        completedAt: now(),
                        errorMessage: args.errorMessage,
                        processedCount: batch.recipients.length,
                        failedCount: batch.recipients.length,
                    });
                    const hasPending = !(await noPending(batch.campaignId, "pending"));
                    return { hasMoreBatches: hasPending };
                }
                case "messages:markAttemptedBatch":
                    // The REAL idempotent upsert — the heart of "recovery = no dup".
                    await markAttemptedBatchImpl(ctx, args);
                    return undefined;
                case "invoicePdfs:recordWhatsAppMediaId": {
                    const row = tables.invoicePdfs.find(
                        (r) => r.campaignId === args.campaignId && r.recipientId === args.recipientId
                    );
                    if (row) {
                        row.whatsappMediaId = args.whatsappMediaId;
                        row.whatsappMediaIdUploadedAt = args.uploadedAt;
                    }
                    return undefined;
                }
                case "messages:updateStatusBatch": {
                    for (const update of args.updates) {
                        const msg = await db
                            .query("messages")
                            .withIndex("by_campaign_recipient", (q: any) =>
                                q.eq("campaignId", args.campaignId).eq("recipientId", update.recipientId)
                            )
                            .first();
                        if (msg) {
                            await db.patch(msg._id, {
                                status: update.status,
                                sentAt: update.sentAt,
                                errorMessage: update.errorMessage,
                                externalMessageId: update.externalMessageId,
                            });
                        }
                    }
                    return undefined;
                }
                default:
                    // notifications:create and any other incidental writes: no-op.
                    return undefined;
            }
        }),
        runAction: vi.fn(async () => undefined),
        scheduler: {
            runAfter: vi.fn(async () => undefined),
        },
    };

    return { ctx, db, tables };
}

/** A Graph `$batch` fake that counts real per-recipient sends and lets each
 *  recipient be scripted `"ok"` (202 delivered) or `"ambiguous429"` (429
 *  sub-response despite the message delivering — the reported bug's core). */
function scriptGraph(behavior: Map<string, "ok" | "ambiguous429">) {
    const sendsByRecipient = new Map<string, number>();
    boundary.sendEmailBatch.mockImplementation(async (msgs: any[]) =>
        msgs.map((m) => {
            const rid = m.headers["X-Recipient-ID"] as string;
            sendsByRecipient.set(rid, (sendsByRecipient.get(rid) ?? 0) + 1);
            if ((behavior.get(rid) ?? "ok") === "ambiguous429") {
                return { success: false, status: 429, error: "429 - throttled (message actually delivered)" };
            }
            return { success: true, status: 202 };
        })
    );
    return sendsByRecipient;
}

const campaignBase = {
    status: "processing",
    channel: "email",
    subject: "Hello {firstName}",
    fromMailbox: "sender@ttt.test",
    name: "Reg Test",
    createdBy: "user1",
    createDynamicsActivity: false,
    createOpportunities: false,
};

/**
 * A Meta send fake for the WhatsApp file-as-source path. Counts real
 * `sendTemplateWithRetry` calls keyed by the recipient's phone (`body.to`) and
 * lets each be scripted `"ok"` (sent) or `"ambiguous"` (Meta returned a
 * non-permanent failure though the message may have delivered — the WhatsApp
 * analogue of the ambiguous 429). The media upload is faked to always succeed so
 * the document-attachment seam is exercised end to end.
 */
function scriptMeta(behavior: Map<string, "ok" | "ambiguous">) {
    const sendsByPhone = new Map<string, number>();
    boundary.uploadWhatsAppMedia.mockResolvedValue({
        mediaId: "meta-media-x",
        mimeType: "application/pdf",
        sizeBytes: 1024,
    });
    boundary.sendTemplateWithRetry.mockImplementation(async (_config: any, body: any) => {
        const to = body.to as string;
        sendsByPhone.set(to, (sendsByPhone.get(to) ?? 0) + 1);
        if ((behavior.get(to) ?? "ok") === "ambiguous") {
            return { status: "failed", errorCode: 131056, errorMessage: "pair-rate (may have delivered)", attempts: 5, latencyMs: 1 };
        }
        return { status: "sent", wamid: `wamid.${to}`, attempts: 1, latencyMs: 1 };
    });
    return sendsByPhone;
}

const whatsappCampaignBase = {
    status: "processing",
    channel: "whatsapp",
    name: "WA Reg Test",
    createdBy: "user1",
    createDynamicsActivity: false,
    createOpportunities: false,
    whatsappTemplateId: "wtmpl",
    // columnRoles present → the file-as-source WhatsApp path.
    columnRoles: { trackingKey: "contactid", invoiceGuid: "invoiceguid" },
    whatsappVariableMappings: JSON.stringify({ "1": "amount", pay_token: "pay_token" }),
};

const whatsappTemplateDoc = {
    _id: "wtmpl",
    name: "bad_debt_reminder",
    language: "en",
    body: "You owe {{1}}.",
    variables: ["1"],
    headerType: "document",
    buttonType: "url",
    buttonText: "Pay Now",
    buttonUrl: "https://pay.ttt.io/{{1}}",
    buttonUrlVariable: "pay_token",
};

function waRecipient(id: string, phone: string) {
    return { id, phone, name: `R ${id}`, variables: JSON.stringify({ amount: "R100", pay_token: `tok-${id}` }) };
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVEX_SITE_URL;
});

describe("send-path idempotency — headline regression (#62)", () => {
    it("ambiguous 429 sub-response settles terminal `failed` with no in-call resend (Graph called once)", async () => {
        // The "$batch sub-request returns 429 while the message actually
        // delivered" case: at-most-once (#57) means the recipient settles
        // `failed` terminally — the whole envelope is never re-sent in-call, which
        // was the source of the reported 6x duplicate.
        const clock = 1_000_000;
        const { ctx, db } = makeHarness(() => clock);
        const campaignId = await db.insert("campaigns", { ...campaignBase });
        await db.insert("campaignBatches", {
            campaignId,
            batchNumber: 0,
            status: "pending",
            recipients: [
                { id: "A", email: "a@x.test", name: "Alice" },
                { id: "B", email: "b@x.test", name: "Bob" },
            ],
        });
        // createBatches seeds a `pending` row per recipient up front (#63).
        await db.insert("messages", { campaignId, recipientId: "A", recipientName: "Alice", status: "pending", channel: "email" });
        await db.insert("messages", { campaignId, recipientId: "B", recipientName: "Bob", status: "pending", channel: "email" });

        const sends = scriptGraph(new Map([["B", "ambiguous429"]]));

        await runChannelSend(ctx, { campaignId: campaignId as any, sender: emailSender, now: () => clock });

        // Each recipient handed to Graph exactly once — no in-call resend.
        expect(boundary.sendEmailBatch).toHaveBeenCalledTimes(1);
        expect(sends.get("A")).toBe(1);
        expect(sends.get("B")).toBe(1);

        const rowFor = (rid: string) => db.query("messages")
            .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", rid))
            .first();
        expect((await rowFor("A"))!.status).toBe("sent");
        // The delivered-but-429 recipient settles `failed` terminally.
        expect((await rowFor("B"))!.status).toBe("failed");
    });

    it("recovers a genuinely-dead `processing` batch and re-runs it with ZERO duplicate sends", async () => {
        // Post-crash state: the worker was killed mid-batch AFTER durably flushing
        // its handled recipients but BEFORE marking the batch complete. Two
        // recipients:
        //   A — got an ambiguous 429 (delivered, but the sub-response said 429) so
        //       it was durably settled `failed`. Re-sending it would be the
        //       reported duplicate.
        //   B — was never handed to Graph before the crash, so its seed row is
        //       still `pending` — genuinely-unfinished work the sweep must finish.
        // The batch is stuck `processing` with a stale heartbeat.
        let clock = 5_000_000;
        const { ctx, db, tables } = makeHarness(() => clock);
        const campaignId = await db.insert("campaigns", { ...campaignBase });
        const staleBeat = clock; // heartbeat as of the crash
        const batchId = await db.insert("campaignBatches", {
            campaignId,
            batchNumber: 0,
            status: "processing",
            heartbeatAt: staleBeat,
            startedAt: staleBeat,
            recipients: [
                { id: "A", email: "a@x.test", name: "Alice" },
                { id: "B", email: "b@x.test", name: "Bob" },
            ],
        });
        await db.insert("messages", { campaignId, recipientId: "A", recipientName: "Alice", status: "failed", channel: "email", errorMessage: "429 - throttled (message actually delivered)" });
        await db.insert("messages", { campaignId, recipientId: "B", recipientName: "Bob", status: "pending", channel: "email" });

        // No recipient should be re-sent that was already handled; B (never sent)
        // should send cleanly on the recovery re-run.
        const sends = scriptGraph(new Map());

        // 1) The real sweep runs after the lease expires → the dead batch is
        //    reclaimed to `pending` and exactly one worker is scheduled.
        clock += LEASE_MS + 1;
        const { recovered } = await recoverStuckBatchesImpl(ctx, () => clock);
        expect(recovered).toBe(1);
        const batch = await db.get(batchId);
        expect(batch!.status).toBe("pending");
        expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
        expect(getFunctionName(ctx.scheduler.runAfter.mock.calls[0][1])).toBe(
            "campaignQueue:processEmailBatch"
        );

        // 2) The scheduled worker fires — re-run through the REAL driver.
        await runChannelSend(ctx, { campaignId: campaignId as any, sender: emailSender, now: () => clock });

        // A (already-handled `failed`) is NEVER re-sent — zero duplicate for the
        // delivered-but-429 message. B (genuinely unfinished) is sent exactly once.
        expect(sends.get("A")).toBeUndefined();
        expect(sends.get("B")).toBe(1);

        const rowFor = (rid: string) => db.query("messages")
            .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", rid))
            .first();
        expect((await rowFor("A"))!.status).toBe("failed"); // untouched
        expect((await rowFor("B"))!.status).toBe("sent"); // completed by the re-run

        // Exactly one `messages` row per recipient — the recovery re-run never
        // duplicated a row either.
        expect(tables.messages.filter((m) => m.recipientId === "A")).toHaveLength(1);
        expect(tables.messages.filter((m) => m.recipientId === "B")).toHaveLength(1);

        // The sweep recovered AND completed the batch — it did its job.
        expect((await db.get(batchId))!.status).toBe("completed");
    });

    it("a crash BEFORE the Graph call (rows only `attempted`) re-runs without duplicating the attempted chunk", async () => {
        // The crash-blast-radius guarantee (#58): markAttempted lands BEFORE the
        // Graph call, so a crash between the two strands the chunk in `attempted`.
        // The re-run must NOT resend it — `attempted` means "handed to Graph,
        // outcome unknown"; auto-resending risks the exact duplicate this seam
        // kills. Recovery of the delivery outcome is a separate operator path (#60).
        let clock = 9_000_000;
        const { ctx, db } = makeHarness(() => clock);
        const campaignId = await db.insert("campaigns", { ...campaignBase });
        const batchId = await db.insert("campaignBatches", {
            campaignId,
            batchNumber: 0,
            status: "processing",
            heartbeatAt: clock,
            startedAt: clock,
            recipients: [{ id: "A", email: "a@x.test", name: "Alice" }],
        });
        // Crash left A `attempted` (marked, then the action died before the response).
        await db.insert("messages", { campaignId, recipientId: "A", recipientName: "Alice", status: "attempted", channel: "email" });

        const sends = scriptGraph(new Map());

        clock += LEASE_MS + 1;
        await recoverStuckBatchesImpl(ctx, () => clock);
        await runChannelSend(ctx, { campaignId: campaignId as any, sender: emailSender, now: () => clock });

        // A stays `attempted`; the re-run sends nothing (no duplicate).
        expect(boundary.sendEmailBatch).not.toHaveBeenCalled();
        expect(sends.get("A")).toBeUndefined();
        const row = await db.query("messages")
            .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", "A"))
            .first();
        expect(row!.status).toBe("attempted");
        expect((await db.get(batchId))!.status).toBe("completed");
    });

    it("file-as-source + attachments: one message per (campaign, tracking key), each carrying its own PDF, seam intact", async () => {
        // The bad-debt path (PRD bad-debt-excel-campaign, #69): the uploaded file is
        // the source of truth (per-recipient `variables` bag) and each recipient's
        // own invoice PDF is fetched from storage at send and inlined. This proves
        // the idempotency seam still holds on that path: each tracking key is handed
        // to Graph exactly once, `markAttempted` lands before the send, and the
        // message that goes out carries THAT recipient's PDF (never a shared one).
        const clock = 12_000_000;
        const { ctx, db } = makeHarness(() => clock);

        // Serve distinct PDF bytes per storageId so we can prove each recipient got
        // their OWN invoice, not a shared attachment. Graph is the mocked boundary
        // (not fetch), so only storage downloads hit this stub.
        const fetchMock = vi.fn(async (url: unknown) => {
            const u = String(url);
            const bytes = new TextEncoder().encode(`PDF:${u}`);
            return new Response(bytes, { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);

        try {
            const campaignId = await db.insert("campaigns", {
                ...campaignBase,
                columnRoles: { trackingKey: "contactid", invoiceGuid: "invoiceid" },
            });
            await db.insert("campaignBatches", {
                campaignId,
                batchNumber: 0,
                status: "pending",
                recipients: [
                    { id: "A", email: "a@x.test", name: "Alice", variables: JSON.stringify({ amount: "R10" }) },
                    { id: "B", email: "b@x.test", name: "Bob", variables: JSON.stringify({ amount: "R20" }) },
                ],
            });
            // Seed rows (#63) + a `generated` PDF per recipient (#68), each its own storageId.
            await db.insert("messages", { campaignId, recipientId: "A", recipientName: "Alice", status: "pending", channel: "email" });
            await db.insert("messages", { campaignId, recipientId: "B", recipientName: "Bob", status: "pending", channel: "email" });
            await db.insert("invoicePdfs", { campaignId, recipientId: "A", invoiceGuid: "g-A", status: "generated", storageId: "store:A" });
            await db.insert("invoicePdfs", { campaignId, recipientId: "B", invoiceGuid: "g-B", status: "generated", storageId: "store:B" });

            const sends = scriptGraph(new Map());

            await runChannelSend(ctx, { campaignId: campaignId as any, sender: emailSender, now: () => clock });

            // Exactly one Graph handoff per tracking key — at-most-once holds.
            expect(sends.get("A")).toBe(1);
            expect(sends.get("B")).toBe(1);

            // Each recipient's message carries its OWN invoice PDF (distinct bytes),
            // proving the per-recipient fetch + inline, not a shared attachment.
            const sentMsgs = boundary.sendEmailBatch.mock.calls[0][0] as any[];
            const byRid = Object.fromEntries(
                sentMsgs.map((m) => [m.headers["X-Recipient-ID"], m])
            );
            const pdfB64 = (rid: string) =>
                byRid[rid].attachments.find((a: any) => a.contentType === "application/pdf")
                    ?.contentBase64;
            const expected = (storageId: string) =>
                Buffer.from(`PDF:https://storage.test/${storageId}`).toString("base64");
            expect(pdfB64("A")).toBe(expected("store:A"));
            expect(pdfB64("B")).toBe(expected("store:B"));
            expect(pdfB64("A")).not.toBe(pdfB64("B"));

            // markAttempted-before-send seam intact: both settled `sent`, one row each.
            const rowFor = (rid: string) => db.query("messages")
                .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", rid))
                .first();
            expect((await rowFor("A"))!.status).toBe("sent");
            expect((await rowFor("B"))!.status).toBe("sent");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("send-path idempotency — WhatsApp file-as-source path (#70)", () => {
    it("one message per (campaign, tracking key): an ambiguous Meta response settles `failed`, each recipient handed to Meta once, with the document attachment seam intact", async () => {
        const clock = 2_000_000;
        const { ctx, db } = makeHarness(() => clock);
        await db.insert("whatsappTemplates", { ...whatsappTemplateDoc });
        const campaignId = await db.insert("campaigns", { ...whatsappCampaignBase });
        await db.insert("campaignBatches", {
            campaignId,
            batchNumber: 0,
            status: "pending",
            recipients: [waRecipient("A", "+27821111111"), waRecipient("B", "+27822222222")],
        });
        // Seed a `pending` message row per recipient (#63) + a `generated` PDF each.
        await db.insert("messages", { campaignId, recipientId: "A", recipientName: "R A", status: "pending", channel: "whatsapp" });
        await db.insert("messages", { campaignId, recipientId: "B", recipientName: "R B", status: "pending", channel: "whatsapp" });
        await db.insert("invoicePdfs", { campaignId, recipientId: "A", invoiceGuid: "gA", status: "generated", storageId: "sA" });
        await db.insert("invoicePdfs", { campaignId, recipientId: "B", invoiceGuid: "gB", status: "generated", storageId: "sB" });

        const sends = scriptMeta(new Map([["27822222222", "ambiguous"]]));

        await runChannelSend(ctx, { campaignId: campaignId as any, sender: whatsappSender, now: () => clock });

        // Each recipient handed to Meta exactly once — no in-call resend.
        expect(sends.get("27821111111")).toBe(1);
        expect(sends.get("27822222222")).toBe(1);
        // Both PDFs uploaded as document media (the attachment seam ran for real).
        expect(boundary.uploadWhatsAppMedia).toHaveBeenCalledTimes(2);

        const rowFor = (rid: string) => db.query("messages")
            .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", rid))
            .first();
        expect((await rowFor("A"))!.status).toBe("sent");
        // The ambiguous-Meta recipient settles `failed` terminally — never re-sent.
        expect((await rowFor("B"))!.status).toBe("failed");
    });

    it("recovers a genuinely-dead `processing` WhatsApp batch and re-runs it with ZERO duplicate sends and a fresh document upload only for the unfinished recipient", async () => {
        let clock = 6_000_000;
        const { ctx, db, tables } = makeHarness(() => clock);
        await db.insert("whatsappTemplates", { ...whatsappTemplateDoc });
        const campaignId = await db.insert("campaigns", { ...whatsappCampaignBase });
        const staleBeat = clock;
        const batchId = await db.insert("campaignBatches", {
            campaignId,
            batchNumber: 0,
            status: "processing",
            heartbeatAt: staleBeat,
            startedAt: staleBeat,
            recipients: [waRecipient("A", "+27821111111"), waRecipient("B", "+27822222222")],
        });
        // Post-crash: A durably settled `failed` (ambiguous), B never sent (`pending`).
        await db.insert("messages", { campaignId, recipientId: "A", recipientName: "R A", status: "failed", channel: "whatsapp", errorMessage: "pair-rate (may have delivered)" });
        await db.insert("messages", { campaignId, recipientId: "B", recipientName: "R B", status: "pending", channel: "whatsapp" });
        await db.insert("invoicePdfs", { campaignId, recipientId: "A", invoiceGuid: "gA", status: "generated", storageId: "sA" });
        await db.insert("invoicePdfs", { campaignId, recipientId: "B", invoiceGuid: "gB", status: "generated", storageId: "sB" });

        const sends = scriptMeta(new Map());

        // 1) Sweep reclaims the dead batch and schedules exactly one WhatsApp worker.
        clock += LEASE_MS + 1;
        const { recovered } = await recoverStuckBatchesImpl(ctx, () => clock);
        expect(recovered).toBe(1);
        expect((await db.get(batchId))!.status).toBe("pending");
        expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
        expect(getFunctionName(ctx.scheduler.runAfter.mock.calls[0][1])).toBe(
            "campaignQueue:processWhatsAppBatch"
        );

        // 2) The re-run through the real driver.
        await runChannelSend(ctx, { campaignId: campaignId as any, sender: whatsappSender, now: () => clock });

        // A (already-handled `failed`) is NEVER re-sent; B (unfinished) sends once.
        expect(sends.get("27821111111")).toBeUndefined();
        expect(sends.get("27822222222")).toBe(1);
        // Only B's PDF was uploaded on the re-run — A was never re-prepared.
        expect(boundary.uploadWhatsAppMedia).toHaveBeenCalledTimes(1);

        const rowFor = (rid: string) => db.query("messages")
            .withIndex("by_campaign_recipient", (q: any) => q.eq("campaignId", campaignId).eq("recipientId", rid))
            .first();
        expect((await rowFor("A"))!.status).toBe("failed"); // untouched
        expect((await rowFor("B"))!.status).toBe("sent"); // completed by the re-run

        // Exactly one message row per recipient — no duplicate row created.
        expect(tables.messages.filter((m) => m.recipientId === "A")).toHaveLength(1);
        expect(tables.messages.filter((m) => m.recipientId === "B")).toHaveLength(1);
        expect((await db.get(batchId))!.status).toBe("completed");
    });
});
