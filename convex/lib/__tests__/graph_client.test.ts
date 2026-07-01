/**
 * Microsoft Graph $batch send tests (PRD #55, issue #57).
 *
 * Drive `sendEmailBatch` against a faked global `fetch` that serves a Graph
 * token and scripted `$batch` responses. The focus is the at-most-once
 * settlement rule: a non-2xx *sub-response* is terminal (no in-call resend),
 * because it may arrive after the message was already accepted and delivered —
 * resending it is what produced the reported 6× duplicate. The only retained
 * retry is the outer envelope: a rejected `$batch` POST (before any sub-request
 * runs) delivered nothing, so retrying the whole envelope is safe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmailBatch, type EmailMessage } from "../graph_client";

function msg(email: string): EmailMessage {
    return { subject: "s", body: "b", toRecipients: [{ email }], fromMailbox: "shared@x.com" };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Install a fake global fetch that serves a Graph token for the token endpoint
 * and delegates `$batch` POSTs to `batchHandler`, invoked with a 0-based call
 * index so a handler can script a different response per attempt.
 */
function installFetch(batchHandler: (callIndex: number) => Response | Promise<Response>) {
    let batchCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/oauth2/") || u.includes("/token")) {
            return jsonResponse({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
        }
        if (u.includes("/$batch")) {
            const r = await batchHandler(batchCalls);
            batchCalls++;
            return r;
        }
        throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const batchPostCount = () =>
        fetchMock.mock.calls.filter(([u]) => String(u).includes("/$batch")).length;
    return { fetchMock, batchPostCount };
}

describe("sendEmailBatch — at-most-once settlement", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        process.env.AZURE_TENANT_ID = "tenant";
        process.env.GRAPH_CLIENT_ID = "client";
        process.env.GRAPH_CLIENT_SECRET = "secret";
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("settles a 429 sub-response as failed with no in-call resend", async () => {
        const { batchPostCount } = installFetch((call) =>
            // If the code resent (old behaviour), the 2nd call would succeed —
            // the assertions below prove we never make it.
            jsonResponse({
                responses:
                    call === 0
                        ? [{ id: "0", status: 429, headers: { "Retry-After": "1" }, body: { error: "throttled" } }]
                        : [{ id: "0", status: 202 }],
            })
        );

        const p = sendEmailBatch([msg("a@x.com")]);
        await vi.runAllTimersAsync();
        const results = await p;

        expect(results[0].success).toBe(false);
        expect(results[0].status).toBe(429);
        expect(batchPostCount()).toBe(1);
    });

    it("settles a 5xx sub-response as failed with no in-call resend", async () => {
        const { batchPostCount } = installFetch((call) =>
            jsonResponse({
                responses:
                    call === 0
                        ? [{ id: "0", status: 503, body: { error: "unavailable" } }]
                        : [{ id: "0", status: 202 }],
            })
        );

        const p = sendEmailBatch([msg("a@x.com")]);
        await vi.runAllTimersAsync();
        const results = await p;

        expect(results[0].success).toBe(false);
        expect(results[0].status).toBe(503);
        expect(batchPostCount()).toBe(1);
    });

    it("settles a mixed batch per sub-response in a single call", async () => {
        const { batchPostCount } = installFetch(() =>
            jsonResponse({
                responses: [
                    { id: "0", status: 202 },
                    { id: "1", status: 500, body: { error: "boom" } },
                ],
            })
        );

        const p = sendEmailBatch([msg("a@x.com"), msg("b@x.com")]);
        await vi.runAllTimersAsync();
        const results = await p;

        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[1].status).toBe(500);
        expect(batchPostCount()).toBe(1);
    });

    it("retries the whole envelope when the $batch POST is rejected (nothing delivered)", async () => {
        const { batchPostCount } = installFetch((call) =>
            call === 0
                ? new Response("service unavailable", { status: 503 })
                : jsonResponse({ responses: [{ id: "0", status: 202 }] })
        );

        const p = sendEmailBatch([msg("a@x.com")]);
        await vi.runAllTimersAsync();
        const results = await p;

        expect(results[0].success).toBe(true);
        expect(batchPostCount()).toBe(2);
    });
});
