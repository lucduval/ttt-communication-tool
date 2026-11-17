/**
 * Build the body for Meta's template-creation endpoint
 *
 *   POST https://graph.facebook.com/{version}/{WABA_ID}/message_templates
 *
 * from one of our stored `whatsappTemplates` rows plus the sample values Meta
 * insists on at creation time (every body variable and every dynamic URL
 * button needs an example, and a media header needs a sample file supplied as
 * a `header_handle` from the resumable upload API).
 *
 * Pure: no network, no Convex. The action in `actions/whatsappTemplateAdmin.ts`
 * does the upload and the POST; this module decides what is sent and refuses,
 * up front, the shapes Meta is known to reject — so an admin sees a plain
 * message instead of a Graph error code.
 */

export interface CreatableTemplate {
    metaTemplateId: string;
    category: string;
    language: string;
    body: string;
    variables: string[];
    headerType?: string;
    headerText?: string;
    headerUrl?: string;
    buttonType?: string;
    buttonText?: string;
    buttonUrl?: string;
    button2Type?: string;
    button2Text?: string;
    button2Url?: string;
}

export interface TemplateExamples {
    /** Sample value per body variable, keyed by the variable name ("1", "first_name", …). */
    body: Record<string, string>;
    /** Sample suffix for `{{1}}` in button #1's URL (dynamic buttons only). */
    button1?: string;
    /** Sample suffix for `{{1}}` in button #2's URL (dynamic buttons only). */
    button2?: string;
}

export type MediaHeaderFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

/** The header format Meta wants for a media header, or null when the header isn't media. */
export function mediaHeaderFormat(headerType: string | undefined): MediaHeaderFormat | null {
    if (headerType === "image") return "IMAGE";
    if (headerType === "video") return "VIDEO";
    if (headerType === "document") return "DOCUMENT";
    return null;
}

const META_CATEGORIES = new Set(["marketing", "utility", "authentication"]);

/** Variables in the order Meta needs them: numeric order for positional, first appearance for named. */
export function orderedBodyVariables(body: string): string[] {
    const seen: string[] = [];
    for (const m of body.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
        if (!seen.includes(m[1])) seen.push(m[1]);
    }
    if (seen.length > 0 && seen.every((n) => /^\d+$/.test(n))) {
        return [...seen].sort((a, b) => Number(a) - Number(b));
    }
    return seen;
}

/**
 * Every reason Meta would refuse this template, in words an admin can act on.
 * Empty means the payload can be built.
 */
export function validateForMeta(t: CreatableTemplate, ex: TemplateExamples): string[] {
    const errors: string[] = [];

    if (!/^[a-z0-9_]{1,512}$/.test(t.metaTemplateId)) {
        errors.push(
            `Meta Template ID "${t.metaTemplateId}" must be lowercase letters, digits and underscores only (e.g. statement_alert_v1).`,
        );
    }
    if (!META_CATEGORIES.has(t.category)) {
        errors.push(`Category "${t.category}" is not one Meta accepts (marketing, utility, authentication).`);
    }
    if (t.category === "authentication") {
        errors.push("Authentication templates use Meta's fixed OTP format and can't be created from this tool.");
    }

    const body = t.body.trim();
    if (!body) errors.push("The body is empty.");
    if (body.length > 1024) errors.push(`The body is ${body.length} characters; Meta allows 1024.`);
    if (/^\{\{[^}]+\}\}/.test(body) || /\{\{[^}]+\}\}[.!?]?$/.test(body)) {
        errors.push("Meta rejects a body that starts or ends with a variable — add some text before/after it.");
    }
    if (/\}\}\s*\{\{/.test(body)) {
        errors.push("Two variables sit next to each other; Meta needs text between them.");
    }

    const vars = orderedBodyVariables(body);
    const positional = vars.every((n) => /^\d+$/.test(n));
    if (!positional && vars.some((n) => /^\d+$/.test(n))) {
        errors.push("The body mixes numbered ({{1}}) and named ({{name}}) variables; Meta allows one style only.");
    }
    if (positional) {
        const expected = vars.map((_, i) => String(i + 1));
        if (vars.join(",") !== expected.join(",")) {
            errors.push(`Numbered variables must run {{1}}, {{2}}, … with no gaps; found ${vars.map((v) => `{{${v}}}`).join(", ")}.`);
        }
    } else {
        for (const n of vars) {
            if (!/^[a-z][a-z0-9_]*$/.test(n)) {
                errors.push(`Named variable {{${n}}} must be lowercase letters, digits and underscores, starting with a letter.`);
            }
        }
    }
    for (const n of vars) {
        if (!ex.body[n]?.trim()) errors.push(`Give a sample value for {{${n}}}.`);
    }

    if (t.headerType === "text") {
        const h = (t.headerText ?? "").trim();
        if (!h) errors.push("Header type is Text but the header text is empty.");
        if (h.length > 60) errors.push(`Header text is ${h.length} characters; Meta allows 60.`);
        if (/\{\{/.test(h)) errors.push("Variables in the header text aren't supported by the send path — use static header text.");
    }
    if (mediaHeaderFormat(t.headerType) && !t.headerUrl) {
        errors.push(`Header type is ${t.headerType} but no sample file is uploaded.`);
    }

    const buttons = [
        { n: 1, type: t.buttonType, text: t.buttonText, url: t.buttonUrl, sample: ex.button1 },
        { n: 2, type: t.button2Type, text: t.button2Text, url: t.button2Url, sample: ex.button2 },
    ];
    for (const b of buttons) {
        if (b.type !== "url") continue;
        if (!b.text?.trim()) errors.push(`Button #${b.n} has no label.`);
        if ((b.text ?? "").length > 25) errors.push(`Button #${b.n} label is over Meta's 25 characters.`);
        if (!b.url || !/^https?:\/\//.test(b.url)) errors.push(`Button #${b.n} URL must start with http(s)://.`);
        const vCount = (b.url?.match(/\{\{/g) ?? []).length;
        if (vCount > 0 && !/\{\{1\}\}$/.test(b.url ?? "")) {
            errors.push(`Button #${b.n} URL may hold one variable, {{1}}, and only at the very end.`);
        }
        if (vCount > 0 && !b.sample?.trim()) errors.push(`Give a sample value for {{1}} in button #${b.n}'s URL.`);
    }

    return errors;
}

/**
 * The JSON body for `POST /{WABA_ID}/message_templates`. Call
 * {@link validateForMeta} first; this assumes the template passed.
 * `headerHandle` is required when the header is media.
 */
export function buildCreateTemplatePayload(
    t: CreatableTemplate,
    ex: TemplateExamples,
    headerHandle?: string,
): Record<string, unknown> {
    const components: Array<Record<string, unknown>> = [];

    const media = mediaHeaderFormat(t.headerType);
    if (t.headerType === "text" && t.headerText) {
        components.push({ type: "HEADER", format: "TEXT", text: t.headerText.trim() });
    } else if (media) {
        if (!headerHandle) throw new Error("A media header needs a header_handle sample.");
        components.push({ type: "HEADER", format: media, example: { header_handle: [headerHandle] } });
    }

    const body = t.body.trim();
    const vars = orderedBodyVariables(body);
    const named = vars.length > 0 && !vars.every((n) => /^\d+$/.test(n));
    const bodyComponent: Record<string, unknown> = { type: "BODY", text: body };
    if (vars.length > 0) {
        bodyComponent.example = named
            ? { body_text_named_params: vars.map((n) => ({ param_name: n, example: ex.body[n].trim() })) }
            : { body_text: [vars.map((n) => ex.body[n].trim())] };
    }
    components.push(bodyComponent);

    const buttons: Array<Record<string, unknown>> = [];
    for (const b of [
        { type: t.buttonType, text: t.buttonText, url: t.buttonUrl, sample: ex.button1 },
        { type: t.button2Type, text: t.button2Text, url: t.button2Url, sample: ex.button2 },
    ]) {
        if (b.type !== "url" || !b.url) continue;
        const button: Record<string, unknown> = { type: "URL", text: (b.text ?? "").trim(), url: b.url };
        if (b.url.includes("{{1}}")) button.example = [b.url.replace("{{1}}", (b.sample ?? "").trim())];
        buttons.push(button);
    }
    if (buttons.length > 0) components.push({ type: "BUTTONS", buttons });

    return {
        name: t.metaTemplateId,
        language: t.language,
        category: t.category.toUpperCase(),
        ...(named ? { parameter_format: "NAMED" } : {}),
        components,
    };
}
