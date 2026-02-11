export interface ClickatellMessageResult {
    apiMessageId: string;
    accepted: boolean;
    to: string;
    error?: unknown;
}

export interface ClickatellResponse {
    messages: ClickatellMessageResult[];
    error?: string;
}

// Environment variables check helper
export function getClickatellConfig(): { apiKey: string } {
    const apiKey = process.env.CLICKATELL_API_KEY;

    if (!apiKey) {
        throw new Error(
            "Missing Clickatell configuration. Required: CLICKATELL_API_KEY"
        );
    }

    return { apiKey };
}

// Upload media to Clickatell and get fileId
export async function uploadClickatellMedia(apiKey: string, fileUrl: string, phoneNumber: string, fileName: string = "header_media", isBroadcast: boolean = false): Promise<string> {
    console.log(`Downloading media from ${fileUrl}...`);
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
        throw new Error(`Failed to download media file: ${fileResponse.statusText}`);
    }
    let contentType = fileResponse.headers.get("content-type");

    // Fallback: guess content type from extension if missing or generic
    if (!contentType || contentType === "application/octet-stream") {
        const ext = fileUrl.split('.').pop()?.toLowerCase();
        if (ext === "png") contentType = "image/png";
        else if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
        else if (ext === "pdf") contentType = "application/pdf";
        else if (ext === "mp4") contentType = "video/mp4";
        // Default back if still unknown
        if (!contentType) contentType = "application/octet-stream";
    }

    const buffer = await fileResponse.arrayBuffer();

    // Map common content types to extensions
    const mimeToExt: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "application/pdf": "pdf",
        "video/mp4": "mp4",
        "image/gif": "gif"
    };

    // Ensure filename has an extension
    let finalFileName = fileName;
    const ext = mimeToExt[contentType] || "";
    if (ext && !finalFileName.toLowerCase().endsWith(`.${ext}`)) {
        // If it has no extension or wrong one, append valid one
        // If it's just a UUID or name without dot, easy. 
        // If it has a dot but unknown ext, we might append. 
        // Let's just append if it doesn't end with the correct one.
        if (!finalFileName.includes(".")) {
            finalFileName = `${finalFileName}.${ext}`;
        } else {
            // It has an extension, let's trust it or replace it? 
            // Safest is to append if strict match failed, but that might make `file.png.jpg`
            // Let's just trust existing extension if present, otherwise append.
        }

        // Actually, if we are sure of the content type, we should force the extension for Clickatell
        if (!finalFileName.split('.').pop()?.match(/^[a-z0-9]+$/i)) {
            finalFileName = `${finalFileName}.${ext}`;
        } else {
            // Check if existing extension matches known types, if not replace/append?
            // Simple logic: if no extension, append.
            if (finalFileName.indexOf('.') === -1) {
                finalFileName = `${finalFileName}.${ext}`;
            }
        }
    }

    let url = `https://platform.clickatell.com/v1/media?fileName=${encodeURIComponent(finalFileName)}`;
    if (isBroadcast) {
        console.log(`Uploading media to Clickatell for BROADCAST (${contentType}). Filename: ${finalFileName}`);
        url += `&broadcastAllowed=true`;
    } else {
        console.log(`Uploading media to Clickatell for ${phoneNumber} (${contentType}). Filename: ${finalFileName}`);
        url += `&to=${encodeURIComponent(phoneNumber)}`;
    }

    // Clickatell expects binary body
    const response = await fetch(
        url,
        {
            method: "POST",
            headers: {
                "Authorization": apiKey,
                "Content-Type": contentType,
            },
            body: buffer,
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Clickatell Media Upload Error: ${text}`);
    }

    const result = await response.json();
    console.log("Media upload result:", result);

    // Fix for "unsupported" suffix if Clickatell appends it
    let fileId = result.fileId;
    if (fileId && fileId.endsWith(".unsupported")) {
        console.warn("Clickatell returned .unsupported fileId, stripping suffix...");
        fileId = fileId.replace(".unsupported", "");
    }

    return fileId;
}
