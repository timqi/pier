// What every view shares when it talks to Pier's own HTTP API — the shape of a
// write, the sentence a failure shows, the scheduling of a re-read. Nine
// modules had grown their own copy of the method/headers/body triple.

/** The wait before a failed request's first retry. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** How long after the first of them reads cut short are retried before they are news: a woken page's network can take this long. */
const QUIET_MS = 15_000;

/** A failure a later success takes back, to the promise that success resolves: report.ts removes its line then. */
export const passing = new WeakMap<object, Promise<void>>();

/** Every wait before a cut-short read's retry, each ending its own. */
const napping = new Set<() => void>();

/** The network is back (main.ts's `online`): every read waiting to be retried runs now. */
export function wakeRetries(): void {
  for (const wake of napping) wake();
}

/** One read's retries: a failure is waited out at 1s doubling to 30s, and one cut short — a deadline fired, or the
 *  network not back yet, on a woken page — is retried in silence until QUIET_MS after the first since the last success. */
export function patience() {
  let backoff = RETRY_MS;
  let since: number | undefined;
  let nap: (() => void) | undefined;
  /** The next wait, the one after it doubled. */
  const delay = (): number => {
    const ms = backoff;
    backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    return ms;
  };
  return {
    delay,
    /** True once `err`'s wait is over, false at once when it is news: not cut short, or past QUIET_MS. */
    async quietly(err: unknown): Promise<boolean> {
      if (!cutShort(err)) return false;
      since ??= Date.now();
      if (Date.now() - since >= QUIET_MS) return false;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          napping.delete(wake);
          nap = undefined;
          resolve();
        };
        const timer = setTimeout(wake, delay());
        napping.add(wake);
        nap = wake;
      });
      return true;
    },
    /** Ends this read's wait: it is asked for again. */
    wake: (): void => nap?.(),
    /** A success: the next failure starts over. */
    reset(): void {
      backoff = RETRY_MS;
      since = undefined;
    },
  };
}

/** `read` until it answers or its failure is news (`patience`); the last answer once `live` says nobody wants it. */
export async function persist<T extends { ok: boolean; cause?: unknown }>(read: () => Promise<T>, live: () => boolean): Promise<T> {
  const retry = patience();
  let got = await read();
  while (!got.ok && (await retry.quietly(got.cause)) && live()) got = await read();
  return got;
}

/** A burst of workspace events costs two fetches, not twenty. A failed load
 *  is retried with backoff until one succeeds: the event that asked for it
 *  will not come again, so the view would otherwise stay stale. It rejects
 *  once per failure until then, for report.ts, not once per retry. */
export function coalesce(load: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  let dirty = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const wait = patience();
  /** The failure already rejected with since the last success. */
  let told: string | undefined;
  /** Resolves each cut-short failure rejected with since the last success. */
  const takeBack: (() => void)[] = [];
  const run = (): Promise<void> => {
    dirty = true;
    clearTimeout(retry);
    wait.wake();
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
        // Retried inside this promise, whose caller is owed the data, not a success; a request asked for meanwhile ends the wait.
        if (!failed || !(await wait.quietly(failed.err))) break;
        dirty = true;
      }
      if (!failed) {
        wait.reset();
        told = undefined;
        for (const back of takeBack.splice(0)) back();
        return;
      }
      retry = setTimeout(() => void run(), wait.delay());
      // Already reported and still being retried: a repeat would only be noise.
      if (String(failed.err) === told) return;
      told = String(failed.err);
      // A network that comes back is not news: the line saying it was gone goes with it.
      if (cutShort(failed.err) && typeof failed.err === "object" && failed.err !== null) {
        passing.set(failed.err, new Promise<void>((resolve) => takeBack.push(resolve)));
      }
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

/** What a fetch rejects with when the network dropped it: WebKit's, Chromium's and Firefox's wording. */
const DROPPED = /^(?:Load failed|Failed to fetch|NetworkError\b)/;

/** A request cut short by its signal — WebKit names even a timeout's `AbortError` — or dropped by
 *  the network, which fetch says with a `TypeError`; or an error carrying one. */
export function cutShort(err: unknown): boolean {
  if (!(err instanceof Error || err instanceof DOMException)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err instanceof TypeError && DROPPED.test(err.message)) return true;
  if (err instanceof Error) return cutShort(err.cause);
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

