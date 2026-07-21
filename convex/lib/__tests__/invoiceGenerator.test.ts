/**
 * Invoice-PDF generator client tests (PRD `prd-bad-debt-excel-campaign.md`, #68).
 *
 * Drive `generateInvoicePdf` against a faked global `fetch` with fake timers, so
 * backoff costs no real wall-clock. The focus is the confirmed #64 contract — POST
 * `{ invoiceId, type? }` to `{base}?code={key}`, read PDF bytes from the
 * `application/pdf` response — and the transient-failure policy: a 429 is retried
 * honouring `Retry-After`, 5xx backs off, and a 4xx (bad/missing invoiceId) is
 * terminal with no retry. Prior art: `graph_client.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    generateInvoicePdf,
    getInvoicePdfConfig,
    type InvoicePdfConfig,
} from "../invoiceGenerator";

const config: InvoicePdfConfig = {
    baseUrl: "https://fn.example.net/api/invoice-generator",
    functionKey: "secret-key",
};

function pdfResponse(bytes: Uint8Array<ArrayBuffer>, status = 200): Response {
    // Wrap in a Blob (a BodyInit) so the DOM lib's typed-array buffer generics
    // don't reject the raw Uint8Array; the source reads it back via arrayBuffer().
    return new Response(new Blob([bytes]), {
        status,
        headers: { "Content-Type": "application/pdf" },
    });
}

/** Install a fake fetch delegating each call to `handler(callIndex)`. */
function installFetch(handler: (callIndex: number) => Response | Promise<Response>) {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
        const r = await handler(calls);
        calls++;
        return r;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

describe("generateInvoicePdf", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("posts { invoiceId, type } to {base}?code={key} and returns the PDF bytes", async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        const fetchMock = installFetch(() => pdfResponse(bytes));

        const p = generateInvoicePdf({ invoiceId: "guid-1", type: "Tax", config });
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.contentType).toBe("application/pdf");
        expect(new Uint8Array(result.bytes)).toEqual(bytes);

        // URL carries the function key as ?code=, and body carries invoiceId + type.
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://fn.example.net/api/invoice-generator?code=secret-key");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ invoiceId: "guid-1", type: "Tax" });
    });

    it("omits type from the body when not supplied", async () => {
        const fetchMock = installFetch(() => pdfResponse(new Uint8Array([1])));

        const p = generateInvoicePdf({ invoiceId: "guid-2", config });
        await vi.runAllTimersAsync();
        await p;

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ invoiceId: "guid-2" });
    });

    it("treats a 400 (bad/missing invoiceId) as terminal — no retry", async () => {
        const fetchMock = installFetch(() => new Response("bad invoiceId", { status: 400 }));

        const p = generateInvoicePdf({ invoiceId: "nope", config });
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 honouring Retry-After, then succeeds", async () => {
        const bytes = new Uint8Array([9]);
        const fetchMock = installFetch((call) =>
            call === 0
                ? new Response("throttled", { status: 429, headers: { "Retry-After": "2" } })
                : pdfResponse(bytes),
        );

        const sleep = vi.fn((ms: number) => Promise.resolve(void ms));
        const p = generateInvoicePdf({ invoiceId: "guid-3", config, sleep });
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Retry-After: 2 → 2000ms honoured.
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("retries a 5xx then fails terminally after maxAttempts", async () => {
        const fetchMock = installFetch(() => new Response("boom", { status: 500 }));

        const sleep = vi.fn(() => Promise.resolve());
        const p = generateInvoicePdf({ invoiceId: "guid-4", config, maxAttempts: 3, sleep });
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.status).toBe(500);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("rejects an empty invoiceId without calling fetch", async () => {
        const fetchMock = installFetch(() => pdfResponse(new Uint8Array([1])));

        const result = await generateInvoicePdf({ invoiceId: "   ", config });

        expect(result.success).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("getInvoicePdfConfig", () => {
    afterEach(() => {
        delete process.env.INVOICE_GENERATOR_URL;
        delete process.env.INVOICE_GENERATOR_KEY;
    });

    it("reads the endpoint + key from the environment", () => {
        process.env.INVOICE_GENERATOR_URL = "https://fn/x";
        process.env.INVOICE_GENERATOR_KEY = "k";
        expect(getInvoicePdfConfig()).toEqual({ baseUrl: "https://fn/x", functionKey: "k" });
    });

    it("throws a clear error naming the missing variables", () => {
        delete process.env.INVOICE_GENERATOR_URL;
        delete process.env.INVOICE_GENERATOR_KEY;
        expect(() => getInvoicePdfConfig()).toThrow(/INVOICE_GENERATOR_URL/);
    });
});
