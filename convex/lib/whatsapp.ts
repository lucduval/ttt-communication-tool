/**
 * Meta WhatsApp Cloud API helpers for bulk + transactional sends.
 *
 * Replaces the previous Clickatell integration. Meta enforces several
 * independent limits per phone number (per-second rate, in-flight concurrency,
 * 24h business-initiated cap), and exposes no batch endpoint — every recipient
 * is its own HTTP request gated through the limiter below.
 */

import { isRetryableHttpStatus } from "./retry";

// ---------- Phone number normalization ----------

/**
 * Normalize a raw phone number to E.164 digits (no leading +).
 * Returns null if the result isn't a plausible E.164 (9-15 digits).
 *
 * Why: Meta rejects formatted numbers and counts rejections against the tier,
 * so we want to skip obviously-malformed numbers before sending.
 */
export function normalizeToE164Digits(
    raw: string | undefined | null,
    defaultCountryCode: string = "27"
): string | null {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, "");
    if (digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
    if (digits.length < 9 || digits.length > 15) return null;
    return digits;
}

/**
 * Back-compat wrapper. Returns digits-only string; falls back to the
 * stripped input if length validation fails (mirrors previous Clickatell
 * behavior so existing call sites keep working — callers that want strict
 * validation should use {@link normalizeToE164Digits} directly).
 */
export function normalizePhoneNumber(phoneNumber: string, defaultCountryCode: string = "27"): string {
    const normalized = normalizeToE164Digits(phoneNumber, defaultCountryCode);
    if (normalized) return normalized;
    const digitsOnly = String(phoneNumber || "").replace(/\D/g, "");
    if (digitsOnly.startsWith("0")) return defaultCountryCode + digitsOnly.slice(1);
    return digitsOnly;
}

// ---------- Config ----------

export interface MetaWhatsAppConfig {
    token: string;
    phoneNumberId: string;
    graphApiVersion: string;
    sendUrl: string;
    maxSendPerSecond: number;
    maxConcurrent: number;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    dailyTierLimit: number;
}

function readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMetaWhatsAppConfig(): MetaWhatsAppConfig {
    const token = process.env.META_WHATSAPP_TOKEN;
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const graphApiVersion = process.env.META_GRAPH_API_VERSION || "v22.0";

    if (!token || !phoneNumberId) {
        throw new Error(
            "Missing Meta WhatsApp configuration. Required: META_WHATSAPP_TOKEN, META_PHONE_NUMBER_ID"
        );
    }

    return {
        token,
        phoneNumberId,
        graphApiVersion,
        sendUrl: `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
        maxSendPerSecond: readNumberEnv("META_MAX_SEND_PER_SECOND", 60),
        maxConcurrent: readNumberEnv("META_MAX_CONCURRENT_REQUESTS", 20),
        retryMaxAttempts: readNumberEnv("META_RETRY_MAX_ATTEMPTS", 5),
        retryBaseDelayMs: readNumberEnv("META_RETRY_BASE_DELAY_MS", 500),
        dailyTierLimit: readNumberEnv("META_DAILY_TIER_LIMIT", 100000),
    };
}

// ---------- Template payload ----------

export interface TemplateLike {
    name: string;
    language: string;
    variables: string[];
    headerType?: string;
    headerText?: string;
    headerUrl?: string;
    /**
     * Meta media ID obtained from the /media upload endpoint. When present,
     * the header component sends `{ id }` instead of `{ link }` — more reliable
     * than asking Meta to re-fetch a public URL on every send.
     */
    headerMediaId?: string;
    /**
     * Optional URL buttons. Meta allows up to two URL buttons per template,
     * occupying button-array positions 0 and 1 in the approved template. Each
     * slot's `*Url` is the URL pattern as approved in Meta; if it contains
     * `{{1}}`, that button is dynamic and `*UrlVariable` names the logical
     * variable whose value replaces the placeholder. Static URL buttons (no
     * `{{1}}`) need no send-time component — Meta uses the approved URL
     * directly.
     */
    buttonType?: string;
    buttonText?: string;
    buttonUrl?: string;
    buttonUrlVariable?: string;
    button2Type?: string;
    button2Text?: string;
    button2Url?: string;
    button2UrlVariable?: string;
}

interface MetaTextParameter {
    type: "text";
    text: string;
    parameter_name?: string;
}

type MetaMediaRef = { link: string } | { id: string };

interface MetaImageParameter {
    type: "image";
    image: MetaMediaRef;
}

interface MetaDocumentParameter {
    type: "document";
    document: MetaMediaRef & { filename?: string };
}

interface MetaVideoParameter {
    type: "video";
    video: MetaMediaRef;
}

type MetaParameter = MetaTextParameter | MetaImageParameter | MetaDocumentParameter | MetaVideoParameter;

interface MetaComponent {
    type: "header" | "body" | "button";
    sub_type?: string;
    index?: string;
    parameters: MetaParameter[];
}

export interface MetaTemplateRequestBody {
    messaging_product: "whatsapp";
    recipient_type: "individual";
    to: string;
    type: "template";
    template: {
        name: string;
        language: { code: string };
        components?: MetaComponent[];
    };
}

/**
 * Heuristic for positional vs named template variables. Templates approved
 * with `{{1}}`, `{{2}}` are positional and must NOT carry `parameter_name`;
 * templates approved with `{{customer_name}}` are named and MUST carry it.
 * The two modes can't be mixed, so we look at every variable name.
 */
function isPositional(variableNames: string[]): boolean {
    if (variableNames.length === 0) return true;
    return variableNames.every((name) => /^\d+$/.test(name));
}

function buildBodyParameters(template: TemplateLike, allVariables: Record<string, string>): MetaTextParameter[] {
    const positional = isPositional(template.variables);
    return template.variables.map((varName) => {
        const param: MetaTextParameter = {
            type: "text",
            text: allVariables[varName] ?? "",
        };
        if (!positional) param.parameter_name = varName;
        return param;
    });
}

/**
 * Detect whether a URL button is dynamic. URL buttons in Meta are always
 * positional with a single variable, so a literal `{{1}}` substring is the
 * unambiguous signal that the button is dynamic.
 */
function isDynamicUrl(type: string | undefined, url: string | undefined): boolean {
    return type === "url" && !!url && url.includes("{{1}}");
}

export function isDynamicUrlButton(template: TemplateLike): boolean {
    return isDynamicUrl(template.buttonType, template.buttonUrl);
}

export function isDynamicUrlButton2(template: TemplateLike): boolean {
    return isDynamicUrl(template.button2Type, template.button2Url);
}

/**
 * Build URL-button components for the template's URL buttons. Only dynamic
 * URL buttons need a component on send (Meta uses the approved URL directly
 * for static buttons). Each button's Meta index is its position in the
 * template's button array: button #1 → "0", button #2 → "1".
 *
 * Per Meta's spec, the parameter value is the suffix that replaces `{{1}}` in
 * the approved URL — NOT the full URL. Meta reconstructs the URL by
 * concatenating the static prefix with this value.
 */
function buildButtonComponents(
    template: TemplateLike,
    allVariables: Record<string, string>
): MetaComponent[] {
    const components: MetaComponent[] = [];
    if (isDynamicUrlButton(template)) {
        const varName = template.buttonUrlVariable;
        components.push({
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: varName ? allVariables[varName] ?? "" : "" }],
        });
    }
    if (isDynamicUrlButton2(template)) {
        const varName = template.button2UrlVariable;
        components.push({
            type: "button",
            sub_type: "url",
            index: "1",
            parameters: [{ type: "text", text: varName ? allVariables[varName] ?? "" : "" }],
        });
    }
    return components;
}

function buildHeaderComponent(template: TemplateLike): MetaComponent | undefined {
    const headerType = template.headerType;
    if (!headerType || headerType === "none") return undefined;

    if (headerType === "text" && template.headerText) {
        return {
            type: "header",
            parameters: [{ type: "text", text: template.headerText }],
        };
    }

    // Prefer a pre-uploaded media id over a public link: Meta keeps the bytes
    // server-side so each send is one POST instead of N URL fetches that can fail.
    const mediaRef: MetaMediaRef | null = template.headerMediaId
        ? { id: template.headerMediaId }
        : template.headerUrl
        ? { link: template.headerUrl }
        : null;
    if (!mediaRef) return undefined;

    if (headerType === "image") {
        return { type: "header", parameters: [{ type: "image", image: mediaRef }] };
    }
    if (headerType === "video") {
        return { type: "header", parameters: [{ type: "video", video: mediaRef }] };
    }
    if (headerType === "document") {
        const filename = template.headerUrl ? template.headerUrl.split("/").pop() || "document" : "document";
        return { type: "header", parameters: [{ type: "document", document: { ...mediaRef, filename } }] };
    }
    return undefined;
}

/**
 * Build a Meta Cloud API template send body for one recipient.
 * - `to` is digits-only E.164 (no leading +).
 * - Body component is omitted entirely if the template has no variables.
 * - Header component is included for media headers and for text headers with content.
 */
export function buildTemplateRequestBody(
    template: TemplateLike,
    toDigits: string,
    allVariables: Record<string, string>
): MetaTemplateRequestBody {
    const components: MetaComponent[] = [];

    const header = buildHeaderComponent(template);
    if (header) components.push(header);

    if (template.variables.length > 0) {
        components.push({ type: "body", parameters: buildBodyParameters(template, allVariables) });
    }

    components.push(...buildButtonComponents(template, allVariables));

    return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toDigits,
        type: "template",
        template: {
            name: template.name,
            language: { code: template.language },
            ...(components.length > 0 ? { components } : {}),
        },
    };
}

// ---------- Error classification ----------

export type MetaErrorClass = "retryable" | "pair-rate" | "permanent";

const PAIR_RATE_CODE = 131056;
const RATE_LIMIT_CODE = 80007;
const TEMPLATE_PERMANENT_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const PERMANENT_RECIPIENT_CODES = new Set([131026, 131047, 130472]);

/**
 * Classify a Meta error code so the caller knows whether to retry the same
 * recipient, skip them permanently, or abort the whole campaign.
 *
 * Codes whose meaning isn't recognized are treated as permanent — better to
 * surface them and stop than to spin on an unknown failure mode.
 */
export function classifyMetaError(errorCode: number | undefined | null): MetaErrorClass {
    if (errorCode == null) return "permanent";
    if (errorCode === PAIR_RATE_CODE) return "pair-rate";
    if (errorCode === RATE_LIMIT_CODE) return "retryable";
    if (TEMPLATE_PERMANENT_CODES.has(errorCode)) return "permanent";
    if (PERMANENT_RECIPIENT_CODES.has(errorCode)) return "permanent";
    return "permanent";
}

export function isTemplatePermanentError(errorCode: number | undefined | null): boolean {
    return errorCode != null && TEMPLATE_PERMANENT_CODES.has(errorCode);
}

// ---------- Rate limiter (token bucket + concurrency cap) ----------

/**
 * Token-bucket limiter scoped to a single action invocation. The bucket refills
 * up to `maxPerSecond` every 1000ms; in parallel, an in-flight semaphore caps
 * concurrent requests so slow Meta responses can't blow open the connection
 * pool when we're already at the per-second ceiling.
 */
export class RateLimiter {
    private tokens: number;
    private readonly maxPerSecond: number;
    private readonly maxConcurrent: number;
    private inFlight = 0;
    private lastRefill: number;
    private readonly waiters: Array<() => void> = [];

    constructor(maxPerSecond: number, maxConcurrent: number) {
        this.maxPerSecond = maxPerSecond;
        this.maxConcurrent = maxConcurrent;
        this.tokens = maxPerSecond;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed >= 1000) {
            this.tokens = this.maxPerSecond;
            this.lastRefill = now;
            while (this.waiters.length > 0 && this.tokens > 0 && this.inFlight < this.maxConcurrent) {
                const wake = this.waiters.shift();
                if (wake) wake();
            }
        }
    }

    private async acquire(): Promise<void> {
        while (true) {
            this.refill();
            if (this.tokens > 0 && this.inFlight < this.maxConcurrent) {
                this.tokens -= 1;
                this.inFlight += 1;
                return;
            }
            const now = Date.now();
            const waitMs = Math.max(10, 1000 - (now - this.lastRefill));
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    const idx = this.waiters.indexOf(resolve);
                    if (idx >= 0) this.waiters.splice(idx, 1);
                    resolve();
                }, waitMs);
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    private release(): void {
        this.inFlight -= 1;
        while (this.waiters.length > 0 && this.inFlight < this.maxConcurrent && this.tokens > 0) {
            const wake = this.waiters.shift();
            if (wake) wake();
        }
    }

    async schedule<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

// ---------- Send + retry ----------

export interface MetaSendSuccess {
    status: "sent";
    wamid: string;
    attempts: number;
    latencyMs: number;
}

export interface MetaSendFailure {
    status: "failed";
    errorCode?: number;
    errorMessage: string;
    attempts: number;
    latencyMs: number;
}

export type MetaSendResult = MetaSendSuccess | MetaSendFailure;

interface MetaErrorBody {
    error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
        fbtrace_id?: string;
    };
}

interface MetaSuccessBody {
    messages?: Array<{ id?: string; message_status?: string }>;
    contacts?: Array<{ input?: string; wa_id?: string }>;
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
        const ms = date - Date.now();
        return ms > 0 ? ms : null;
    }
    return null;
}

function backoffDelayMs(attempt: number, baseDelayMs: number, extraJitter: boolean): number {
    const exp = baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * (extraJitter ? 1000 : 250));
    return exp + jitter;
}

export async function sendTemplateWithRetry(
    config: MetaWhatsAppConfig,
    body: MetaTemplateRequestBody
): Promise<MetaSendResult> {
    const start = Date.now();
    let attempts = 0;

    for (let attempt = 0; attempt < config.retryMaxAttempts; attempt++) {
        attempts = attempt + 1;
        let response: Response;
        try {
            response = await fetch(config.sendUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.token}`,
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown network error";
            if (attempt === config.retryMaxAttempts - 1) {
                return { status: "failed", errorMessage: `Network error: ${message}`, attempts, latencyMs: Date.now() - start };
            }
            await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, config.retryBaseDelayMs, false)));
            continue;
        }

        if (response.ok) {
            const json = (await response.json()) as MetaSuccessBody;
            const wamid = json.messages?.[0]?.id;
            if (!wamid) {
                return {
                    status: "failed",
                    errorMessage: "Meta returned 2xx but no message id",
                    attempts,
                    latencyMs: Date.now() - start,
                };
            }
            return { status: "sent", wamid, attempts, latencyMs: Date.now() - start };
        }

        const errorText = await response.text();
        let errorCode: number | undefined;
        let errorMessage = errorText;
        try {
            const parsed = JSON.parse(errorText) as MetaErrorBody;
            errorCode = parsed.error?.code;
            errorMessage = parsed.error?.message || errorText;
        } catch {
            // non-JSON error body — leave message as raw text
        }

        const classification = classifyMetaError(errorCode);
        const isHttpRetryable = isRetryableHttpStatus(response.status);

        // Permanent business errors never retry, regardless of HTTP status.
        if (errorCode != null && classification === "permanent") {
            return { status: "failed", errorCode, errorMessage, attempts, latencyMs: Date.now() - start };
        }

        // Last attempt — give up.
        if (attempt === config.retryMaxAttempts - 1) {
            return { status: "failed", errorCode, errorMessage, attempts, latencyMs: Date.now() - start };
        }

        // Non-retryable HTTP status with no recognized retryable error code — give up.
        if (!isHttpRetryable && classification !== "retryable" && classification !== "pair-rate") {
            return { status: "failed", errorCode, errorMessage, attempts, latencyMs: Date.now() - start };
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const delay = retryAfter ?? backoffDelayMs(attempt, config.retryBaseDelayMs, classification === "pair-rate");
        await new Promise((r) => setTimeout(r, delay));
    }

    return {
        status: "failed",
        errorMessage: "retry budget exhausted",
        attempts,
        latencyMs: Date.now() - start,
    };
}

// ---------- Media upload (POST /{phone_number_id}/media) ----------

/**
 * Meta-imposed limits per content category. Bytes. Trying to upload a file
 * larger than this returns a permanent error from Meta, so we reject early
 * to avoid wasting bandwidth on a doomed upload.
 *
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */
export const META_MEDIA_LIMITS: Readonly<Record<string, number>> = Object.freeze({
    "image/jpeg": 5 * 1024 * 1024,
    "image/png": 5 * 1024 * 1024,
    "video/mp4": 16 * 1024 * 1024,
    "video/3gp": 16 * 1024 * 1024,
    "application/pdf": 100 * 1024 * 1024,
    "application/msword": 100 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 100 * 1024 * 1024,
    "application/vnd.ms-powerpoint": 100 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": 100 * 1024 * 1024,
    "application/vnd.ms-excel": 100 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 100 * 1024 * 1024,
    "text/plain": 100 * 1024 * 1024,
});

/**
 * Maps header categories to the set of MIME types Meta accepts. Used to
 * sanity-check that a given file actually matches the template's header type
 * before we POST to /media.
 */
export const META_HEADER_MIME_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    image: new Set(["image/jpeg", "image/png"]),
    video: new Set(["video/mp4", "video/3gp"]),
    document: new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/plain",
    ]),
});

/**
 * Best-effort MIME inference from a URL's extension. The Content-Type header
 * from the source server is preferred; this is a fallback for hosts that
 * return `application/octet-stream` or omit the header entirely.
 */
export function inferMimeFromUrl(url: string): string | null {
    const path = url.split("?")[0].split("#")[0].toLowerCase();
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
    switch (ext) {
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "png":
            return "image/png";
        case "mp4":
            return "video/mp4";
        case "3gp":
            return "video/3gp";
        case "pdf":
            return "application/pdf";
        case "doc":
            return "application/msword";
        case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "ppt":
            return "application/vnd.ms-powerpoint";
        case "pptx":
            return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        case "xls":
            return "application/vnd.ms-excel";
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "txt":
            return "text/plain";
        default:
            return null;
    }
}

export interface MediaUploadResult {
    mediaId: string;
    mimeType: string;
    sizeBytes: number;
}

/**
 * Fetch a public URL and upload its bytes to Meta's /media endpoint, returning
 * the resulting media id. The id replaces the public link in template header
 * components, which is the pattern Meta recommends for production sends:
 *   - one fetch (us → CDN) instead of one fetch per recipient (Meta → CDN)
 *   - removes the failure mode where a flaky CDN drops mid-campaign
 *   - id is valid for ~30 days, after which we re-upload
 *
 * `headerType` (image/video/document) gates the MIME types we'll accept so
 * we don't waste an upload that the template would reject at send time.
 */
export async function uploadWhatsAppMedia(
    config: MetaWhatsAppConfig,
    params: {
        sourceUrl: string;
        headerType: "image" | "video" | "document";
        mimeTypeOverride?: string;
    }
): Promise<MediaUploadResult> {
    const sourceResp = await fetch(params.sourceUrl);
    if (!sourceResp.ok) {
        throw new Error(
            `Failed to fetch media from ${params.sourceUrl}: HTTP ${sourceResp.status} ${sourceResp.statusText}`
        );
    }

    // Order: explicit override → upstream Content-Type → URL extension. The
    // override exists because some CDNs serve everything as octet-stream and
    // the URL extension may be wrong or absent.
    const upstreamMime = sourceResp.headers.get("content-type")?.split(";")[0]?.trim();
    const inferred = inferMimeFromUrl(params.sourceUrl);
    const mimeType =
        params.mimeTypeOverride ||
        (upstreamMime && upstreamMime !== "application/octet-stream" ? upstreamMime : null) ||
        inferred;

    if (!mimeType) {
        throw new Error(
            `Could not determine MIME type for ${params.sourceUrl} — set the source server's Content-Type header or pass mimeTypeOverride`
        );
    }

    const allowed = META_HEADER_MIME_BY_TYPE[params.headerType];
    if (!allowed || !allowed.has(mimeType)) {
        throw new Error(
            `MIME type '${mimeType}' is not valid for a '${params.headerType}' header. ` +
                `Meta accepts: ${allowed ? Array.from(allowed).join(", ") : "(none)"}`
        );
    }

    const buffer = await sourceResp.arrayBuffer();
    const sizeBytes = buffer.byteLength;
    const limit = META_MEDIA_LIMITS[mimeType];
    if (limit != null && sizeBytes > limit) {
        throw new Error(
            `Media size ${sizeBytes} bytes exceeds Meta limit ${limit} bytes for ${mimeType}`
        );
    }

    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("type", mimeType);
    formData.append(
        "file",
        new Blob([buffer], { type: mimeType }),
        params.sourceUrl.split("/").pop() || "upload"
    );

    const uploadUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/media`;
    const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
        body: formData,
    });

    if (!uploadResp.ok) {
        const text = await uploadResp.text();
        throw new Error(`Meta media upload failed (HTTP ${uploadResp.status}): ${text}`);
    }

    const json = (await uploadResp.json()) as { id?: string };
    if (!json.id) {
        throw new Error("Meta media upload returned no id");
    }

    return { mediaId: json.id, mimeType, sizeBytes };
}

/**
 * Meta media ids expire 30 days after upload. We refresh at 25 days to leave
 * a safety margin against clock skew and long-running campaigns that span
 * the boundary.
 */
export const META_MEDIA_ID_REFRESH_AFTER_MS = 25 * 24 * 60 * 60 * 1000;

export function isMediaIdFresh(uploadedAt: number | undefined | null, now: number = Date.now()): boolean {
    if (!uploadedAt) return false;
    return now - uploadedAt < META_MEDIA_ID_REFRESH_AFTER_MS;
}

/**
 * Header categories that send as uploaded media. Text headers and "none"
 * don't participate in the media-upload path.
 */
const MEDIA_HEADER_TYPES = new Set(["image", "video", "document"]);

export function isMediaHeaderType(headerType: string | undefined | null): headerType is "image" | "video" | "document" {
    return headerType != null && MEDIA_HEADER_TYPES.has(headerType);
}

/**
 * State of the template's cached media id, used to decide whether to upload.
 * Tracked separately from the schema doc so callers can pass plain objects in
 * tests without depending on Convex types.
 */
export interface CachedMediaState {
    headerMediaId?: string;
    headerMediaIdUploadedAt?: number;
    headerMediaSourceUrl?: string;
}

export function shouldRefreshMediaId(
    cached: CachedMediaState,
    currentSourceUrl: string,
    now: number = Date.now()
): boolean {
    if (!cached.headerMediaId) return true;
    if (cached.headerMediaSourceUrl !== currentSourceUrl) return true;
    return !isMediaIdFresh(cached.headerMediaIdUploadedAt, now);
}
