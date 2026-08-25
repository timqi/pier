import { isObject } from "./json.js";

/** One POST of JSON to a provider endpoint: timeout, transient-status retry, parsed body. */

const TIMEOUT_MS = Number(process.env.PIER_WEB_TIMEOUT_MS) || 60_000;
const MAX_RETRIES = 2;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Carries the status, so a caller can tell "this endpoint refused the request"
 *  from "this endpoint is having a bad minute" (openai.ts does, on a 400). */
export class HttpError extends Error {
  status: number;
  reason: string;

  constructor(status: number, reason: string, label: string) {
    super(`${label} ${status}: ${reason}`);
    this.name = "HttpError";
    this.status = status;
    this.reason = reason;
  }
}

/** Both providers report failures as `{ error: string | { message } }`. */
function errorMessage(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  if (typeof data.error === "string") return data.error;
  return isObject(data.error) && typeof data.error.message === "string"
    ? data.error.message
    : undefined;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const after = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 20_000);
  // Jittered: tools run in parallel, and a rate limit hits them at the same
  // instant, so a fixed backoff has them all come back at the same instant too.
  return Math.round(500 * 2 ** attempt * (0.5 + Math.random()));
}

/**
 * Interruptible, because the backoff is inside the caller's deadline: a
 * `retry-after` sleep of up to 20s followed by a whole further request is how a
 * 90-second ceiling turned into two minutes. Rejects on abort; the caller
 * reports the failure that caused the backoff, which is the useful half.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export async function postJson(
  label: string,
  url: string,
  headers: Headers,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body);
  let failure: HttpError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      // The caller's abort is final; our own timeout and transport faults are retryable.
      if (signal?.aborted) throw error;
      failure = new HttpError(
        408,
        timeout.aborted
          ? `request timed out after ${TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error),
        label,
      );
      if (attempt === MAX_RETRIES) throw failure;
      await sleep(retryDelay(undefined, attempt), signal).catch(() => {
        throw failure;
      });
      continue;
    }

    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    if (response.ok) {
      if (!isObject(data)) throw new Error(`${label} returned a non-JSON response body`);
      return data;
    }

    failure = new HttpError(
      response.status,
      errorMessage(data) || raw.slice(0, 500) || response.statusText,
      label,
    );
    if (!RETRY_STATUS.has(response.status) || attempt === MAX_RETRIES) throw failure;
    await sleep(retryDelay(response, attempt), signal).catch(() => {
      throw failure;
    });
  }
  throw failure ?? new Error(`${label} request failed`);
}
