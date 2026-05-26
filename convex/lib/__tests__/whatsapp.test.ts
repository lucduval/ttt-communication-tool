import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    getMetaWhatsAppConfig,
    normalizeToE164Digits,
    buildTemplateRequestBody,
    classifyMetaError,
    isTemplatePermanentError,
    inferMimeFromUrl,
    isMediaIdFresh,
    shouldRefreshMediaId,
    uploadWhatsAppMedia,
    META_MEDIA_ID_REFRESH_AFTER_MS,
    META_MEDIA_LIMITS,
    type MetaWhatsAppConfig,
    type TemplateLike,
} from '../whatsapp';

describe('getMetaWhatsAppConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    it('returns config with required fields when env vars are set', () => {
        process.env.META_WHATSAPP_TOKEN = 'test-token';
        process.env.META_PHONE_NUMBER_ID = '1234567890';
        const config = getMetaWhatsAppConfig();
        expect(config.token).toBe('test-token');
        expect(config.phoneNumberId).toBe('1234567890');
        expect(config.graphApiVersion).toBe('v22.0');
        expect(config.sendUrl).toBe('https://graph.facebook.com/v22.0/1234567890/messages');
        expect(config.maxSendPerSecond).toBe(60);
        expect(config.maxConcurrent).toBe(20);
        expect(config.retryMaxAttempts).toBe(5);
        expect(config.retryBaseDelayMs).toBe(500);
        expect(config.dailyTierLimit).toBe(100000);
    });

    it('honors overrides for graph version and limits', () => {
        process.env.META_WHATSAPP_TOKEN = 'tok';
        process.env.META_PHONE_NUMBER_ID = '9';
        process.env.META_GRAPH_API_VERSION = 'v23.0';
        process.env.META_MAX_SEND_PER_SECOND = '40';
        process.env.META_MAX_CONCURRENT_REQUESTS = '10';
        process.env.META_DAILY_TIER_LIMIT = '10000';
        const config = getMetaWhatsAppConfig();
        expect(config.sendUrl).toBe('https://graph.facebook.com/v23.0/9/messages');
        expect(config.maxSendPerSecond).toBe(40);
        expect(config.maxConcurrent).toBe(10);
        expect(config.dailyTierLimit).toBe(10000);
    });

    it('throws when required env vars are missing', () => {
        delete process.env.META_WHATSAPP_TOKEN;
        delete process.env.META_PHONE_NUMBER_ID;
        expect(() => getMetaWhatsAppConfig()).toThrow('Missing Meta WhatsApp configuration');
    });
});

describe('normalizeToE164Digits', () => {
    it('strips formatting and returns digits-only', () => {
        expect(normalizeToE164Digits('+27 82 123 4567')).toBe('27821234567');
        expect(normalizeToE164Digits('27-82-123-4567')).toBe('27821234567');
    });

    it('prepends default country code when number starts with 0', () => {
        expect(normalizeToE164Digits('0821234567')).toBe('27821234567');
    });

    it('uses an alternate country code when provided', () => {
        expect(normalizeToE164Digits('0712345678', '44')).toBe('44712345678');
    });

    it('returns null for inputs outside the 9-15 digit E.164 range', () => {
        expect(normalizeToE164Digits('1234')).toBeNull();
        expect(normalizeToE164Digits('1234567890123456')).toBeNull();
    });

    it('returns null for empty / nullish input', () => {
        expect(normalizeToE164Digits('')).toBeNull();
        expect(normalizeToE164Digits(undefined)).toBeNull();
        expect(normalizeToE164Digits(null)).toBeNull();
    });
});

describe('buildTemplateRequestBody', () => {
    const baseTemplate: TemplateLike = {
        name: 'welcome_message',
        language: 'en',
        variables: ['1', '2'],
    };

    it('builds a positional template body with no header', () => {
        const body = buildTemplateRequestBody(
            baseTemplate,
            '27821234567',
            { '1': 'Alice', '2': 'Acme' }
        );
        expect(body.messaging_product).toBe('whatsapp');
        expect(body.recipient_type).toBe('individual');
        expect(body.to).toBe('27821234567');
        expect(body.template.name).toBe('welcome_message');
        expect(body.template.language.code).toBe('en');
        expect(body.template.components).toHaveLength(1);
        expect(body.template.components![0]).toEqual({
            type: 'body',
            parameters: [
                { type: 'text', text: 'Alice' },
                { type: 'text', text: 'Acme' },
            ],
        });
    });

    it('emits parameter_name when variable names are not numeric', () => {
        const template: TemplateLike = {
            name: 'reminder',
            language: 'en_US',
            variables: ['customer_name', 'due_date'],
        };
        const body = buildTemplateRequestBody(template, '27821234567', {
            customer_name: 'Alice',
            due_date: '2026-05-21',
        });
        expect(body.template.components![0].parameters).toEqual([
            { type: 'text', text: 'Alice', parameter_name: 'customer_name' },
            { type: 'text', text: '2026-05-21', parameter_name: 'due_date' },
        ]);
    });

    it('omits the body component when the template has no variables', () => {
        const template: TemplateLike = {
            name: 'no_vars',
            language: 'en',
            variables: [],
        };
        const body = buildTemplateRequestBody(template, '27821234567', {});
        expect(body.template.components).toBeUndefined();
    });

    it('includes an image header component when headerType is image', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            headerType: 'image',
            headerUrl: 'https://cdn.example.com/banner.png',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components![0]).toEqual({
            type: 'header',
            parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/banner.png' } }],
        });
    });

    it('includes a video header component as a link when no media id is cached', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            headerType: 'video',
            headerUrl: 'https://cdn.example.com/intro.mp4',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components![0]).toEqual({
            type: 'header',
            parameters: [{ type: 'video', video: { link: 'https://cdn.example.com/intro.mp4' } }],
        });
    });

    it('prefers the uploaded media id over the link for video headers', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            headerType: 'video',
            headerUrl: 'https://cdn.example.com/intro.mp4',
            headerMediaId: '999888777',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components![0]).toEqual({
            type: 'header',
            parameters: [{ type: 'video', video: { id: '999888777' } }],
        });
    });

    it('prefers the uploaded media id over the link for document headers and keeps filename', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            headerType: 'document',
            headerUrl: 'https://cdn.example.com/spec.pdf',
            headerMediaId: 'doc-1',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components![0]).toEqual({
            type: 'header',
            parameters: [{ type: 'document', document: { id: 'doc-1', filename: 'spec.pdf' } }],
        });
    });

    it('skips header when headerType is "none"', () => {
        const template: TemplateLike = { ...baseTemplate, headerType: 'none' };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components!.every((c) => c.type !== 'header')).toBe(true);
    });

    it('emits a URL button component with the substituted suffix for dynamic URL buttons', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            buttonType: 'url',
            buttonText: 'Share with a friend',
            buttonUrl: 'https://riivo.io/refer?code={{1}}',
            buttonUrlVariable: 'riivo_referralcode',
        };
        const body = buildTemplateRequestBody(template, '27821234567', {
            '1': 'A',
            '2': 'B',
            riivo_referralcode: 'john12345',
        });
        const button = body.template.components!.find((c) => c.type === 'button');
        expect(button).toEqual({
            type: 'button',
            sub_type: 'url',
            index: '0',
            // Only the suffix replacing {{1}} — Meta appends it to the static
            // prefix from the approved template. NOT the full URL.
            parameters: [{ type: 'text', text: 'john12345' }],
        });
    });

    it('omits the button component for static URL buttons (no {{1}} placeholder)', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            buttonType: 'url',
            buttonText: 'Visit site',
            buttonUrl: 'https://riivo.io/about',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        expect(body.template.components!.every((c) => c.type !== 'button')).toBe(true);
    });

    it('omits the button component when the button is absent or none', () => {
        const noneTemplate: TemplateLike = { ...baseTemplate, buttonType: 'none' };
        const noneBody = buildTemplateRequestBody(noneTemplate, '27821234567', { '1': 'A', '2': 'B' });
        expect(noneBody.template.components!.every((c) => c.type !== 'button')).toBe(true);

        const noField: TemplateLike = { ...baseTemplate };
        const noFieldBody = buildTemplateRequestBody(noField, '27821234567', { '1': 'A', '2': 'B' });
        expect(noFieldBody.template.components!.every((c) => c.type !== 'button')).toBe(true);
    });

    it('falls back to an empty suffix when the dynamic variable is missing from the map', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            buttonType: 'url',
            buttonUrl: 'https://riivo.io/refer?code={{1}}',
            buttonUrlVariable: 'riivo_referralcode',
        };
        const body = buildTemplateRequestBody(template, '27821234567', { '1': 'A', '2': 'B' });
        const button = body.template.components!.find((c) => c.type === 'button');
        expect(button).toEqual({
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '' }],
        });
    });

    it('combines header, body and button components in order', () => {
        const template: TemplateLike = {
            ...baseTemplate,
            headerType: 'image',
            headerUrl: 'https://cdn.example.com/banner.png',
            buttonType: 'url',
            buttonUrl: 'https://riivo.io/refer?code={{1}}',
            buttonUrlVariable: 'riivo_referralcode',
        };
        const body = buildTemplateRequestBody(template, '27821234567', {
            '1': 'Alice',
            '2': 'Acme',
            riivo_referralcode: 'abc',
        });
        expect(body.template.components!.map((c) => c.type)).toEqual(['header', 'body', 'button']);
    });
});

describe('inferMimeFromUrl', () => {
    it('maps common video extensions', () => {
        expect(inferMimeFromUrl('https://cdn.example.com/clip.mp4')).toBe('video/mp4');
        expect(inferMimeFromUrl('https://cdn.example.com/CLIP.MP4?v=2')).toBe('video/mp4');
        expect(inferMimeFromUrl('https://cdn.example.com/clip.3gp')).toBe('video/3gp');
    });

    it('maps common image and document extensions', () => {
        expect(inferMimeFromUrl('https://x/y.jpg')).toBe('image/jpeg');
        expect(inferMimeFromUrl('https://x/y.jpeg')).toBe('image/jpeg');
        expect(inferMimeFromUrl('https://x/y.png')).toBe('image/png');
        expect(inferMimeFromUrl('https://x/y.pdf')).toBe('application/pdf');
        expect(inferMimeFromUrl('https://x/y.txt')).toBe('text/plain');
    });

    it('returns null for unknown or missing extensions', () => {
        expect(inferMimeFromUrl('https://x/y')).toBeNull();
        expect(inferMimeFromUrl('https://x/y.bin')).toBeNull();
    });
});

describe('isMediaIdFresh / shouldRefreshMediaId', () => {
    const now = 1_700_000_000_000;

    it('treats missing uploadedAt as stale', () => {
        expect(isMediaIdFresh(undefined, now)).toBe(false);
        expect(isMediaIdFresh(null, now)).toBe(false);
    });

    it('is fresh inside the 25-day window and stale past it', () => {
        expect(isMediaIdFresh(now - (META_MEDIA_ID_REFRESH_AFTER_MS - 1000), now)).toBe(true);
        expect(isMediaIdFresh(now - META_MEDIA_ID_REFRESH_AFTER_MS, now)).toBe(false);
    });

    it('refreshes when there is no cached media id', () => {
        expect(shouldRefreshMediaId({}, 'https://x/y.mp4', now)).toBe(true);
    });

    it('refreshes when the source URL has changed', () => {
        expect(
            shouldRefreshMediaId(
                {
                    headerMediaId: 'm1',
                    headerMediaIdUploadedAt: now - 1000,
                    headerMediaSourceUrl: 'https://x/old.mp4',
                },
                'https://x/new.mp4',
                now
            )
        ).toBe(true);
    });

    it('does not refresh when id is fresh and URL is unchanged', () => {
        expect(
            shouldRefreshMediaId(
                {
                    headerMediaId: 'm1',
                    headerMediaIdUploadedAt: now - 1000,
                    headerMediaSourceUrl: 'https://x/y.mp4',
                },
                'https://x/y.mp4',
                now
            )
        ).toBe(false);
    });
});

describe('uploadWhatsAppMedia', () => {
    const config: MetaWhatsAppConfig = {
        token: 'test-token',
        phoneNumberId: '111',
        graphApiVersion: 'v22.0',
        sendUrl: 'https://graph.facebook.com/v22.0/111/messages',
        maxSendPerSecond: 60,
        maxConcurrent: 20,
        retryMaxAttempts: 5,
        retryBaseDelayMs: 500,
        dailyTierLimit: 100000,
    };

    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function mockFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
        const fn = vi.fn();
        responses.forEach((r) => fn.mockResolvedValueOnce(r));
        globalThis.fetch = fn as unknown as typeof fetch;
        return fn;
    }

    it('uploads a video and returns the media id from Meta', async () => {
        const videoBytes = new Uint8Array(1024); // 1 KB
        const sourceResp = new Response(videoBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
        });
        const uploadResp = new Response(JSON.stringify({ id: 'media-abc-123' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
        const fetchMock = mockFetchSequence([sourceResp, uploadResp]);

        const result = await uploadWhatsAppMedia(config, {
            sourceUrl: 'https://cdn.example.com/clip.mp4',
            headerType: 'video',
        });

        expect(result.mediaId).toBe('media-abc-123');
        expect(result.mimeType).toBe('video/mp4');
        expect(result.sizeBytes).toBe(1024);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [uploadUrl, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(uploadUrl).toBe('https://graph.facebook.com/v22.0/111/media');
        expect(uploadInit.method).toBe('POST');
        expect((uploadInit.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
        expect(uploadInit.body).toBeInstanceOf(FormData);
        const form = uploadInit.body as FormData;
        expect(form.get('messaging_product')).toBe('whatsapp');
        expect(form.get('type')).toBe('video/mp4');
        expect(form.get('file')).toBeInstanceOf(Blob);
    });

    it('falls back to URL extension when source server omits Content-Type', async () => {
        const sourceResp = new Response(new Uint8Array(8), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
        });
        const uploadResp = new Response(JSON.stringify({ id: 'm2' }), { status: 200 });
        mockFetchSequence([sourceResp, uploadResp]);

        const result = await uploadWhatsAppMedia(config, {
            sourceUrl: 'https://cdn.example.com/clip.mp4',
            headerType: 'video',
        });
        expect(result.mimeType).toBe('video/mp4');
    });

    it('rejects when the MIME does not match the header category', async () => {
        const sourceResp = new Response(new Uint8Array(8), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        });
        mockFetchSequence([sourceResp]);

        await expect(
            uploadWhatsAppMedia(config, {
                sourceUrl: 'https://cdn.example.com/photo.jpg',
                headerType: 'video',
            })
        ).rejects.toThrow(/not valid for a 'video' header/);
    });

    it('rejects when the file is larger than the Meta limit', async () => {
        const oversized = new Uint8Array(META_MEDIA_LIMITS['video/mp4'] + 1);
        const sourceResp = new Response(oversized, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
        });
        mockFetchSequence([sourceResp]);

        await expect(
            uploadWhatsAppMedia(config, {
                sourceUrl: 'https://cdn.example.com/huge.mp4',
                headerType: 'video',
            })
        ).rejects.toThrow(/exceeds Meta limit/);
    });

    it('surfaces a useful error when the upload endpoint returns non-200', async () => {
        const sourceResp = new Response(new Uint8Array(16), {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
        });
        const uploadResp = new Response('{"error":{"message":"bad token","code":190}}', { status: 401 });
        mockFetchSequence([sourceResp, uploadResp]);

        await expect(
            uploadWhatsAppMedia(config, {
                sourceUrl: 'https://cdn.example.com/clip.mp4',
                headerType: 'video',
            })
        ).rejects.toThrow(/Meta media upload failed \(HTTP 401\)/);
    });

    it('throws when MIME cannot be determined', async () => {
        const sourceResp = new Response(new Uint8Array(8), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
        });
        mockFetchSequence([sourceResp]);

        await expect(
            uploadWhatsAppMedia(config, {
                sourceUrl: 'https://cdn.example.com/mystery',
                headerType: 'video',
            })
        ).rejects.toThrow(/Could not determine MIME type/);
    });
});

describe('classifyMetaError', () => {
    it('maps 80007 (rate limit) to retryable', () => {
        expect(classifyMetaError(80007)).toBe('retryable');
    });

    it('maps 131056 (pair rate) to pair-rate', () => {
        expect(classifyMetaError(131056)).toBe('pair-rate');
    });

    it('maps 131026 (unreachable recipient) to permanent', () => {
        expect(classifyMetaError(131026)).toBe('permanent');
    });

    it('maps 132012 (template variable mismatch) to permanent', () => {
        expect(classifyMetaError(132012)).toBe('permanent');
    });

    it('returns permanent for unknown / null codes', () => {
        expect(classifyMetaError(null)).toBe('permanent');
        expect(classifyMetaError(999999)).toBe('permanent');
    });
});

describe('isTemplatePermanentError', () => {
    it('is true for 132xxx template codes only', () => {
        expect(isTemplatePermanentError(132000)).toBe(true);
        expect(isTemplatePermanentError(132012)).toBe(true);
        expect(isTemplatePermanentError(132016)).toBe(true);
        expect(isTemplatePermanentError(131026)).toBe(false);
        expect(isTemplatePermanentError(80007)).toBe(false);
        expect(isTemplatePermanentError(null)).toBe(false);
    });
});
