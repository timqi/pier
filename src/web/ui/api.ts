// What every view shares when it talks to Pier's own HTTP API — the shape of a
// write, the sentence a failure shows, the scheduling of a re-read. Nine
// modules had grown their own copy of the method/headers/body triple.

const RETRY_MAX_MS = 30_000;

/** A burst of workspace events costs two fetches, not twenty. A failed load
 *  is retried with backoff until one succeeds: the event that asked for it
 *  will not come again, so the view would otherwise stay stale. It rejects
 *  once per failure until then, for report.ts, not once per retry. */
export function coalesce(load: () => Promise<void>, retryMs = 1000): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  let dirty = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = retryMs;
  /** The failure already rejected with since the last success. */
  let told: string | undefined;
  /** A read was cut short since the last success. */
  let cut = false;
  /** Ends the wait before a cut-short read's retry: a request asked for meanwhile runs now. */
  let wake: (() => void) | undefined;
  const run = (): Promise<void> => {
    dirty = true;
    clearTimeout(retry);
    wake?.();
    return inflight ??= (async () => {
      let failed: { err: unknown } | undefined;
      for (;;) {
        // A request asked for during a failed load still runs.
        while (dirty) {
          dirty = false;
          try {
            await load();
            failed = undefined;
          } catch (err) {
            failed = { err };
          }
        }
        // A read's deadline fires on wake when the page was suspended mid-read, so the first abort
        // is retried before it is news — inside this promise, whose caller is owed the data, not a
        // success; a second in a row is a server that does not answer.
        if (!failed || cut || !aborted(failed.err)) break;
        cut = true;
        await new Promise<void>((resolve) => {
          wake = resolve;
          retry = setTimeout(resolve, backoff);
        });
        wake = undefined;
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
        dirty = true;
      }
      if (!failed) {
        backoff = retryMs;
        told = undefined;
        cut = false;
        return;
      }
      retry = setTimeout(() => void run(), backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      // Already reported and still being retried: a repeat would only be noise.
      if (String(failed.err) === told) return;
      told = String(failed.err);
      throw failed.err;
    })().finally(() => {
      inflight = undefined;
    });
  };
  return run;
}

const jsonInit = (body: unknown, method: "POST" | "PUT" | "PATCH"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** POST (or PUT/PATCH) a JSON body; the caller owns the response. */
export const sendJson = (
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" = "POST",
): Promise<Response> => fetch(url, jsonInit(body, method));

/** `sendJson` whose answer is read like `getJson`'s: the value, or the sentence. */
export const postJson = <T>(
  url: string,
  body: unknown,
  fallback: string,
  method: "POST" | "PUT" = "POST",
): Promise<Fetched<T>> => getJson<T>(url, fallback, jsonInit(body, method));

/** Read a failed response's `error`, whatever the server managed to send. */
export async function failure(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

/** A request cut short by its signal — WebKit names even a timeout's `AbortError` — or an error carrying one. */
export function aborted(err: unknown): boolean {
  if (!(err instanceof Error || err instanceof DOMException)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err instanceof Error) return aborted(err.cause);
  return false;
}

/** What a read got: the value, or the sentence to show for not having it,
 *  with what was thrown when the read did not get as far as a refusal. */
type Fetched<T> = { ok: true; value: T } | { ok: false; error: string; cause?: unknown };

/** A refusal keeps the server's own sentence, and a request that never
 *  answered is a result, not a rejection into a `void` call (§5). */
export async function getJson<T>(
  url: string,
  fallback: string,
  init?: RequestInit,
): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { ok: false, error: `${fallback}: ${String(err)}`, cause: err };
  }
  if (!res.ok) return { ok: false, error: await failure(res, fallback) };
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: `${fallback}: ${String(err)}`, cause: err };
  }
}

/** For a caller already inside a `try`. Throws the sentence, never the
 *  `Response`, which is how `[object Object]` reaches a pane. */
export async function mustGetJson<T>(
  url: string,
  fallback: string,
  init?: RequestInit,
): Promise<T> {
  const got = await getJson<T>(url, fallback, init);
  if (!got.ok) throw new Error(got.error, { cause: got.cause });
  return got.value;
}

/** A bodiless POST or DELETE where the only answer worth having is the
 *  sentence for a refusal; never rejects. */
export async function refused(
  url: string,
  method: "POST" | "DELETE",
  fallback: string,
  keepalive = false,
): Promise<string | undefined> {
  try {
    const res = await fetch(url, keepalive ? { method, keepalive } : { method });
    return res.ok ? undefined : await failure(res, fallback);
  } catch (err) {
    return `${fallback}: ${String(err)}`;
  }
}

