/**
 * Upload helpers for campaign / template images.
 *
 * Images are uploaded to Convex storage at insert time and referenced from
 * HTML as `<img src="https://<convex-site>/image?id=<storageId>">`. This
 * keeps htmlContent small enough to round-trip through templates (Convex's
 * per-value limit is 1 MiB) and lets the campaign send path stream image
 * bytes from storage once per batch instead of inlining them in every email.
 *
 * `normalizeInlineBase64Images` exists for backward compatibility — older
 * templates and pasted HTML may still embed images as `data:` URLs. Calling
 * it on save migrates those to storage URLs in a single pass.
 */

export type GenerateUploadUrl = () => Promise<string>;

const INLINE_BASE64_IMG_REGEX = /<img([^>]+)src="data:(image\/[^;]+);base64,([^"]+)"([^>]*)>/gi;

export interface UploadedImageRef {
    storageId: string;
    url: string;
    contentId: string;
    contentType: string;
    name: string;
}

export function getConvexSiteUrl(): string {
    const url = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
    if (!url) {
        throw new Error("NEXT_PUBLIC_CONVEX_SITE_URL is not configured");
    }
    return url;
}

export function buildImageUrl(siteUrl: string, storageId: string): string {
    return `${siteUrl}/image?id=${storageId}`;
}

/**
 * Upload a file (or blob) to Convex storage and return a public-style
 * reference that can be embedded directly in HTML.
 */
export async function uploadFileToStorage(
    file: File | Blob,
    generateUploadUrl: GenerateUploadUrl,
    siteUrl: string,
    options?: { name?: string; contentType?: string },
): Promise<UploadedImageRef> {
    const contentType = options?.contentType ?? file.type ?? "application/octet-stream";
    const name = options?.name ?? (file instanceof File ? file.name : "image");

    const postUrl = await generateUploadUrl();
    const result = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: file,
    });
    if (!result.ok) {
        throw new Error(`Upload failed with status ${result.status}`);
    }
    const { storageId } = (await result.json()) as { storageId: string };

    return {
        storageId,
        url: buildImageUrl(siteUrl, storageId),
        contentId: `img_${storageId}`,
        contentType,
        name,
    };
}

/**
 * Walk an HTML string for inline base64 `<img>` tags, upload each to
 * Convex storage, and return a new HTML string with `src` swapped to
 * hosted URLs. Returns the original HTML unchanged when no inline images
 * are present so callers can use this unconditionally without paying for
 * a regex walk on already-normalized HTML in the hot path.
 */
export async function normalizeInlineBase64Images(
    html: string,
    generateUploadUrl: GenerateUploadUrl,
    siteUrl: string,
): Promise<{ html: string; uploaded: UploadedImageRef[] }> {
    // Cheap pre-check — most saves won't have any inline base64 once the
    // composer is doing upload-at-insert, so we skip the regex compile.
    if (!html.includes("src=\"data:image/")) {
        return { html, uploaded: [] };
    }

    const matches: Array<{ full: string; before: string; contentType: string; base64: string; after: string }> = [];
    const re = new RegExp(INLINE_BASE64_IMG_REGEX);
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        matches.push({
            full: m[0],
            before: m[1],
            contentType: m[2],
            base64: m[3],
            after: m[4],
        });
    }

    const uploaded: UploadedImageRef[] = [];
    let nextHtml = html;
    for (const match of matches) {
        const buffer = base64ToArrayBuffer(match.base64);
        const blob = new Blob([buffer], { type: match.contentType });
        const ref = await uploadFileToStorage(blob, generateUploadUrl, siteUrl, {
            contentType: match.contentType,
            name: `image.${match.contentType.split("/")[1] ?? "bin"}`,
        });
        uploaded.push(ref);
        nextHtml = nextHtml.replace(
            match.full,
            `<img${match.before}src="${ref.url}"${match.after}>`,
        );
    }

    return { html: nextHtml, uploaded };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return buffer;
}
