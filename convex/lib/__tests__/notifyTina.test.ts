import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { notifyTinaOfOutboundTemplate, substitutedBodyVariables } from '../notifyTina';

describe('substitutedBodyVariables', () => {
    it('maps each template variable name to its substituted value, in order', () => {
        const result = substitutedBodyVariables(['1', '2'], { '1': 'John', '2': 'R500' });
        expect(result).toEqual(['John', 'R500']);
    });

    it('works for named variables', () => {
        const result = substitutedBodyVariables(['first_name', 'amount'], {
            first_name: 'Luc',
            amount: 'R1 200',
        });
        expect(result).toEqual(['Luc', 'R1 200']);
    });

    it('falls back to empty string for missing values rather than undefined', () => {
        expect(substitutedBodyVariables(['1', '2'], { '1': 'John' })).toEqual(['John', '']);
    });

    it('returns an empty array for a template with no variables', () => {
        expect(substitutedBodyVariables([], { foo: 'bar' })).toEqual([]);
    });
});

describe('notifyTinaOfOutboundTemplate', () => {
    const originalEnv = process.env;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.BOT_HOST = 'https://bot.example.com';
        process.env.OUTBOUND_NOTIFY_SECRET = 'shh-secret';
    });

    afterEach(() => {
        process.env = originalEnv;
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function mockFetch(response: Response | Error): ReturnType<typeof vi.fn> {
        const fn = vi.fn();
        if (response instanceof Error) fn.mockRejectedValueOnce(response);
        else fn.mockResolvedValueOnce(response);
        globalThis.fetch = fn as unknown as typeof fetch;
        return fn;
    }

    it('POSTs a correctly-signed payload to /webhook/outbound-notify', async () => {
        const fetchMock = mockFetch(new Response('{}', { status: 200 }));

        await notifyTinaOfOutboundTemplate({
            phone: '27821234567',
            templateName: 'ttt_referral_welcome',
            templateLanguage: 'en',
            templateVariables: ['Luc'],
            senderMessageId: 'wamid.ABC',
            sentAt: '2026-06-01T00:00:00.000Z',
            sender: 'manual_test',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://bot.example.com/webhook/outbound-notify');
        expect(init.method).toBe('POST');

        const body = init.body as string;
        const parsed = JSON.parse(body);
        expect(parsed).toMatchObject({
            phone: '27821234567',
            template_name: 'ttt_referral_welcome',
            template_language: 'en',
            template_variables: ['Luc'],
            sender_message_id: 'wamid.ABC',
            sent_at: '2026-06-01T00:00:00.000Z',
            sender: 'manual_test',
        });

        // Signature is the HMAC of the EXACT bytes that were POSTed.
        const headers = init.headers as Record<string, string>;
        const expectedSig = createHmac('sha256', 'shh-secret').update(body).digest('hex');
        expect(headers['X-Outbound-Signature']).toBe(expectedSig);
    });

    it('defaults language, variables, and sender when omitted', async () => {
        const fetchMock = mockFetch(new Response('{}', { status: 200 }));

        await notifyTinaOfOutboundTemplate({
            phone: '27821234567',
            templateName: 't',
            senderMessageId: 'wamid.X',
            sentAt: '2026-06-01T00:00:00.000Z',
        });

        const parsed = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(parsed.template_language).toBe('en');
        expect(parsed.template_variables).toEqual([]);
        expect(parsed.sender).toBe('campaign_app');
    });

    it('strips a trailing slash from BOT_HOST', async () => {
        process.env.BOT_HOST = 'https://bot.example.com/';
        const fetchMock = mockFetch(new Response('{}', { status: 200 }));

        await notifyTinaOfOutboundTemplate({
            phone: '1',
            templateName: 't',
            senderMessageId: 'wamid.X',
        });

        expect(fetchMock.mock.calls[0][0]).toBe('https://bot.example.com/webhook/outbound-notify');
    });

    it('skips the call entirely when env vars are missing', async () => {
        delete process.env.BOT_HOST;
        const fetchMock = mockFetch(new Response('{}', { status: 200 }));

        await notifyTinaOfOutboundTemplate({
            phone: '1',
            templateName: 't',
            senderMessageId: 'wamid.X',
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never throws on a non-2xx response', async () => {
        mockFetch(new Response('bad signature', { status: 401 }));

        await expect(
            notifyTinaOfOutboundTemplate({
                phone: '1',
                templateName: 't',
                senderMessageId: 'wamid.X',
            })
        ).resolves.toBeUndefined();
    });

    it('never throws on a network error', async () => {
        mockFetch(new Error('ECONNREFUSED'));

        await expect(
            notifyTinaOfOutboundTemplate({
                phone: '1',
                templateName: 't',
                senderMessageId: 'wamid.X',
            })
        ).resolves.toBeUndefined();
    });
});
