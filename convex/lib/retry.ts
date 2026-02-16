/**
 * Retry utility with exponential backoff for transient failures.
 * Retries on: network errors, 429 (rate limit), 5xx server errors.
 */

const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 504];

export function isRetryableHttpStatus(status: number): boolean {
    return RETRYABLE_HTTP_STATUS.includes(status);
}

export function isRetryableError(error: unknown): boolean {
    if (error instanceof TypeError && (error.message || "").includes("fetch")) {
        return true; // Network error
    }
    if (error instanceof Error) {
        const msg = (error.message || "").toLowerCase();
        if (msg.includes("network") || msg.includes("econnreset") || msg.includes("etimedout")) {
            return true;
        }
    }
    return false;
}

export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
}

/**
 * Execute an async function with retries on transient failure.
 * Uses exponential backoff: baseDelay * 2^(attempt-1)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 1000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (attempt === maxAttempts) throw e;
            if (!isRetryableError(e)) throw e;

            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}
