// What every view shares when it talks to Pier's own HTTP API — the shape of a
// write, the sentence a failure shows, the scheduling of a re-read. Nine
// modules had grown their own copy of the method/headers/body triple.

/** A burst of workspace events costs two fetches, not twenty. */
export function coalesce(load: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  let dirty = false;
  return () => {
    dirty = true;
    return inflight ??= (async () => {
      while (dirty) {
        dirty = false;
        await load();
      }
    })().finally(() => {
      inflight = undefined;
    });
  };
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

/** What a read got: the value, or the sentence to show for not having it. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

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
    return { ok: false, error: `${fallback}: ${String(err)}` };
  }
  if (!res.ok) return { ok: false, error: await failure(res, fallback) };
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: `${fallback}: ${String(err)}` };
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
  if (!got.ok) throw new Error(got.error);
  return got.value;
}

/** A bodiless POST or DELETE where the only answer worth having is the
 *  sentence for a refusal; never rejects. */
export async function refused(
  url: string,
  method: "POST" | "DELETE",
  fallback: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method });
    return res.ok ? undefined : await failure(res, fallback);
  } catch (err) {
    return `${fallback}: ${String(err)}`;
  }
}

