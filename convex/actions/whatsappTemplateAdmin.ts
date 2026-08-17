"use node";
import { v, ConvexError } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

import { getMetaWhatsAppConfig, type MetaWhatsAppConfig } from "../lib/whatsapp";
import {
    TEMPLATES,
    buildBody,
    PAY_URL,
    PAY_URL_PREFIX,
    type SeedWaTemplate,
} from "../seedWhatsappTemplates";

/**
 * Create the 24 bad-debt WhatsApp templates in Meta via the Graph API — the
 * *authoring* counterpart of `seedWhatsappTemplates.ts`, which only mirrors
 * already-approved templates into our DB. The app's normal send path can only
 * *use* an approved template; this action is what gets them into Meta's review
 * queue in the first place.
 *
 * Meta template creation lives on the WhatsApp Business Account (WABA), not on
 * the phone number the send path uses:
 *
 *   POST https://graph.facebook.com/{version}/{WABA_ID}/message_templates
 *
 * and requires a token with the `whatsapp_business_management` permission (the
 * send path only needs `whatsapp_business_messaging`). Because our templates
 * carry a DOCUMENT header, Meta also wants a *sample* document at creation time
 * — supplied as a `header_handle` obtained from the resumable upload API, which
 * is keyed by the Meta **App ID**. We derive the App ID (and verify the token's
 * scopes) from `GET /debug_token`, so the only new secret you must provide is
 * the WABA id.
 *
 * Environment (in addition to the existing send config):
 *   • META_WABA_ID   (required) — the WhatsApp Business Account id.
 *   • META_APP_ID    (optional) — overrides the App ID auto-derived from the token.
 *
 * Idempotent: templates whose name already exists on the WABA are skipped, so
 * re-running only fills gaps (Meta rejects duplicate name+language anyway).
 *
 * Run (after setting META_WABA_ID and providing a sample PDF), e.g.:
 *   npx convex run actions/whatsappTemplateAdmin:createBadDebtTemplatesInMeta \
 *     "$(cat scratch-args.json)"      # { "samplePdfBase64": "..." }  or  { "samplePdfUrl": "https://..." }
 *
 * Pass `{ "dryRun": true }` first to validate config + payloads without writing
 * anything to Meta.
 */

const GRAPH = "https://graph.facebook.com";

// A representative payment token so Meta sees a well-formed example URL for the
// "Pay now" button (button {{1}} is replaced by the per-recipient suffix).
const SAMPLE_PAYMENT_TOKEN = "abc123-sample-token";
// Example body values (Meta requires a sample for every positional variable).
const SAMPLE_BODY_VARS = ["Thabo", "R1 234.00"];

interface DebugToken {
    appId: string;
    scopes: string[];
    isValid: boolean;
}

/** Resolve the App ID and the token's granted scopes from Graph's debug_token. */
async function inspectToken(config: MetaWhatsAppConfig): Promise<DebugToken> {
    const url =
        `${GRAPH}/${config.graphApiVersion}/debug_token` +
        `?input_token=${encodeURIComponent(config.token)}` +
        `&access_token=${encodeURIComponent(config.token)}`;
    const resp = await fetch(url);
    const json = (await resp.json()) as {
        data?: {
            app_id?: string;
            is_valid?: boolean;
            scopes?: string[];
            granular_scopes?: Array<{ scope?: string }>;
        };
        error?: { message?: string };
    };
    if (!resp.ok || !json.data) {
        throw new ConvexError(
            `Could not inspect the Meta token (HTTP ${resp.status}): ${json.error?.message ?? "no data"}`,
        );
    }
    const d = json.data;
    const scopes = [
        ...(d.scopes ?? []),
        ...(d.granular_scopes ?? []).map((g) => g.scope).filter((s): s is string => !!s),
    ];
    return { appId: d.app_id ?? "", scopes, isValid: d.is_valid === true };
}

/** Fetch the sample PDF bytes from a URL or decode the supplied base64. */
async function loadSamplePdf(args: {
    samplePdfUrl?: string;
    samplePdfBase64?: string;
}): Promise<ArrayBuffer> {
    if (args.samplePdfBase64) {
        const buf = Buffer.from(args.samplePdfBase64, "base64");
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (args.samplePdfUrl) {
        const resp = await fetch(args.samplePdfUrl);
        if (!resp.ok) {
            throw new ConvexError(`Failed to fetch sample PDF (HTTP ${resp.status}) from ${args.samplePdfUrl}`);
        }
        return await resp.arrayBuffer();
    }
    throw new ConvexError("Provide either samplePdfBase64 or samplePdfUrl for the header sample.");
}

/**
 * Upload the sample document via the resumable upload API and return its
 * `header_handle`. Two steps: create an upload session on the App, then POST
 * the bytes to that session (note the `OAuth` auth scheme on step 2, per Meta).
 */
async function uploadSampleHeaderHandle(
    config: MetaWhatsAppConfig,
    appId: string,
    pdf: ArrayBuffer,
): Promise<string> {
    const createUrl =
        `${GRAPH}/${config.graphApiVersion}/${appId}/uploads` +
        `?file_name=${encodeURIComponent("sample-invoice.pdf")}` +
        `&file_length=${pdf.byteLength}` +
        `&file_type=${encodeURIComponent("application/pdf")}`;
    const createResp = await fetch(createUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
    });
    const createJson = (await createResp.json()) as { id?: string; error?: { message?: string } };
    if (!createResp.ok || !createJson.id) {
        throw new ConvexError(
            `Resumable upload session failed (HTTP ${createResp.status}): ${createJson.error?.message ?? "no session id"}. ` +
                `Check META_APP_ID / that the token can access this app.`,
        );
    }

    const uploadResp = await fetch(`${GRAPH}/${config.graphApiVersion}/${createJson.id}`, {
        method: "POST",
        headers: {
            // Step 2 uses the OAuth scheme (not Bearer), per Meta's resumable upload docs.
            Authorization: `OAuth ${config.token}`,
            file_offset: "0",
        },
        body: new Blob([pdf], { type: "application/pdf" }),
    });
    const uploadJson = (await uploadResp.json()) as { h?: string; error?: { message?: string } };
    if (!uploadResp.ok || !uploadJson.h) {
        throw new ConvexError(
            `Sample document upload failed (HTTP ${uploadResp.status}): ${uploadJson.error?.message ?? "no handle"}`,
        );
    }
    return uploadJson.h;
}

/** The `components` array for one template — HEADER, BODY, FOOTER, BUTTONS. */
function buildComponents(t: SeedWaTemplate, headerHandle: string) {
    return [
        { type: "HEADER", format: "DOCUMENT", example: { header_handle: [headerHandle] } },
        {
            type: "BODY",
            text: buildBody(t),
            example: { body_text: [SAMPLE_BODY_VARS] },
        },
        { type: "FOOTER", text: "TTT Financial Group" },
        {
            type: "BUTTONS",
            buttons: [
                {
                    type: "URL",
                    text: "Pay now",
                    url: PAY_URL, // `${PAY_URL_PREFIX}{{1}}`
                    example: [`${PAY_URL_PREFIX}${SAMPLE_PAYMENT_TOKEN}`],
                },
            ],
        },
    ];
}

/** Names of templates that already exist on the WABA (any status), for skipping. */
async function fetchExistingTemplateNames(
    config: MetaWhatsAppConfig,
    wabaId: string,
): Promise<Set<string>> {
    const names = new Set<string>();
    let next: string | null =
        `${GRAPH}/${config.graphApiVersion}/${wabaId}/message_templates?fields=name,status,language&limit=200`;
    while (next) {
        const resp = await fetch(next, { headers: { Authorization: `Bearer ${config.token}` } });
        const json = (await resp.json()) as {
            data?: Array<{ name?: string }>;
            paging?: { next?: string };
            error?: { message?: string };
        };
        if (!resp.ok) {
            throw new ConvexError(
                `Could not list existing templates (HTTP ${resp.status}): ${json.error?.message ?? "unknown"}`,
            );
        }
        for (const row of json.data ?? []) if (row.name) names.add(row.name);
        next = json.paging?.next ?? null;
    }
    return names;
}

/** Fetch name→{status,category} for all templates on the WABA (paginated). */
async function fetchTemplateStates(
    config: MetaWhatsAppConfig,
    wabaId: string,
): Promise<Map<string, { status: string; category: string }>> {
    const states = new Map<string, { status: string; category: string }>();
    let next: string | null =
        `${GRAPH}/${config.graphApiVersion}/${wabaId}/message_templates?fields=name,status,category&limit=200`;
    while (next) {
        const resp = await fetch(next, { headers: { Authorization: `Bearer ${config.token}` } });
        const json = (await resp.json()) as {
            data?: Array<{ name?: string; status?: string; category?: string }>;
            paging?: { next?: string };
            error?: { message?: string };
        };
        if (!resp.ok) {
            throw new ConvexError(
                `Could not list templates (HTTP ${resp.status}): ${json.error?.message ?? "unknown"}`,
            );
        }
        for (const row of json.data ?? []) {
            if (row.name) {
                states.set(row.name, {
                    status: (row.status ?? "").toLowerCase(),
                    category: (row.category ?? "").toLowerCase(),
                });
            }
        }
        next = json.paging?.next ?? null;
    }
    return states;
}

/**
 * Pull the real Meta status + category for the 24 bad-debt templates and write
 * them into the DB (via `whatsappTemplates.applyMetaStatuses`), so the seeded
 * "approved" no longer disagrees with Meta while review is pending. Read-only
 * against Meta; only touches our own template rows. Run with:
 *   npx convex run actions/whatsappTemplateAdmin:reconcileMetaStatuses
 */
export const reconcileMetaStatuses = internalAction({
    args: {},
    returns: v.object({
        fetched: v.number(),
        updated: v.number(),
        unchanged: v.number(),
        notFoundInDb: v.array(v.string()),
        missingInMeta: v.array(v.string()),
        statuses: v.array(v.object({ metaTemplateId: v.string(), status: v.string(), category: v.string() })),
    }),
    handler: async (ctx, _args) => {
        const config = getMetaWhatsAppConfig();
        const wabaId = process.env.META_WABA_ID;
        if (!wabaId) throw new ConvexError("Missing META_WABA_ID.");

        const states = await fetchTemplateStates(config, wabaId);

        const statuses: Array<{ metaTemplateId: string; status: string; category: string }> = [];
        const missingInMeta: string[] = [];
        for (const t of TEMPLATES) {
            const s = states.get(t.metaTemplateId);
            if (!s) {
                missingInMeta.push(t.metaTemplateId);
                continue;
            }
            statuses.push({ metaTemplateId: t.metaTemplateId, status: s.status, category: s.category });
        }

        const result: { updated: number; unchanged: number; notFound: string[] } =
            await ctx.runMutation(internal.whatsappTemplates.applyMetaStatuses, { statuses });

        return {
            fetched: statuses.length,
            updated: result.updated,
            unchanged: result.unchanged,
            notFoundInDb: result.notFound,
            missingInMeta,
            statuses,
        };
    },
});

export const createBadDebtTemplatesInMeta = internalAction({
    args: {
        samplePdfBase64: v.optional(v.string()),
        samplePdfUrl: v.optional(v.string()),
        /** Validate config + build payloads and the header handle, but create nothing. */
        dryRun: v.optional(v.boolean()),
        /** Restrict to specific metaTemplateIds (default: all 24). */
        only: v.optional(v.array(v.string())),
        /** Override the template language (default "en", matching the seed). */
        language: v.optional(v.string()),
    },
    returns: v.object({
        appId: v.string(),
        scopeOk: v.boolean(),
        headerHandle: v.optional(v.string()),
        dryRun: v.boolean(),
        created: v.number(),
        skipped: v.number(),
        failed: v.number(),
        results: v.array(
            v.object({
                metaTemplateId: v.string(),
                outcome: v.string(), // "created" | "skipped" | "failed" | "would-create"
                metaId: v.optional(v.string()),
                status: v.optional(v.string()),
                error: v.optional(v.string()),
            }),
        ),
    }),
    handler: async (_ctx, args) => {
        const config = getMetaWhatsAppConfig();
        const wabaId = process.env.META_WABA_ID;
        if (!wabaId) {
            throw new ConvexError("Missing META_WABA_ID — the WhatsApp Business Account id is required to create templates.");
        }
        const language = args.language ?? "en";

        // 1. Inspect the token: derive App ID + confirm the management scope.
        const tokenInfo = await inspectToken(config);
        const appId = process.env.META_APP_ID || tokenInfo.appId;
        if (!appId) {
            throw new ConvexError(
                "Could not determine the Meta App ID from the token; set META_APP_ID explicitly.",
            );
        }
        const scopeOk = tokenInfo.scopes.includes("whatsapp_business_management");
        if (!scopeOk) {
            throw new ConvexError(
                `The Meta token is missing the 'whatsapp_business_management' permission (granted: ${
                    tokenInfo.scopes.join(", ") || "none reported"
                }). Template creation will fail — use a token/System User with that scope.`,
            );
        }

        // 2. Upload the sample document once; reuse the handle for all templates.
        const pdf = await loadSamplePdf(args);
        const headerHandle = await uploadSampleHeaderHandle(config, appId, pdf);

        // 3. Which of the 24 to attempt, minus any already on the WABA.
        const wanted = args.only && args.only.length > 0
            ? TEMPLATES.filter((t) => args.only!.includes(t.metaTemplateId))
            : TEMPLATES;
        const existing = await fetchExistingTemplateNames(config, wabaId);

        const results: Array<{
            metaTemplateId: string;
            outcome: string;
            metaId?: string;
            status?: string;
            error?: string;
        }> = [];
        let created = 0;
        let skipped = 0;
        let failed = 0;

        for (const t of wanted) {
            if (existing.has(t.metaTemplateId)) {
                skipped++;
                results.push({ metaTemplateId: t.metaTemplateId, outcome: "skipped" });
                continue;
            }

            const payload = {
                name: t.metaTemplateId, // Meta names are lowercase snake_case — our metaTemplateId already is.
                language,
                category: "UTILITY",
                components: buildComponents(t, headerHandle),
            };

            if (args.dryRun) {
                results.push({ metaTemplateId: t.metaTemplateId, outcome: "would-create" });
                continue;
            }

            const resp = await fetch(
                `${GRAPH}/${config.graphApiVersion}/${wabaId}/message_templates`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${config.token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                },
            );
            const json = (await resp.json()) as {
                id?: string;
                status?: string;
                error?: { message?: string; error_user_msg?: string };
            };
            if (resp.ok && json.id) {
                created++;
                results.push({
                    metaTemplateId: t.metaTemplateId,
                    outcome: "created",
                    metaId: json.id,
                    status: json.status,
                });
            } else {
                failed++;
                results.push({
                    metaTemplateId: t.metaTemplateId,
                    outcome: "failed",
                    error: json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${resp.status}`,
                });
            }
        }

        return {
            appId,
            scopeOk,
            headerHandle,
            dryRun: args.dryRun === true,
            created,
            skipped,
            failed,
            results,
        };
    },
});
