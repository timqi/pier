// What every view shares when it talks to Pier's own HTTP API — the shape of a
// write, the sentence a failure shows, the scheduling of a re-read. Nine
// modules had grown their own copy of the method/headers/body triple.

/**
 * One list request in flight at a time; anything asked for during one runs
 * after it, so a burst of workspace events costs two fetches, not twenty.
 */
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

/** POST (or PUT/PATCH) a JSON body; the caller owns the response. */
export const sendJson = (
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" = "POST",
): Promise<Response> =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * What a write did. Kept distinct from a plain `Response` because both callers
 * need the same three cases and got them subtly wrong on their own: nothing
 * was sent, it worked, or here is the sentence to show a human.
 */
export type Sent = { sent: false } | { sent: true; error?: string };

/** Read a failed response's `error`, whatever the server managed to send. */
export async function failure(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

/** What a read got: the value, or the sentence to show for not having it. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * GET something this instance answers as JSON.
 *
 * The write side was consolidated long ago and the read side was not, so a
 * dozen views had their own `fetch` → `res.ok` → `json()` — agreeing on the
 * happy path and differing on the two that matter: a refusal whose body
 * carries the server's own sentence (thrown away by most of them, leaving
 * `(500)`), and a request that never answered, which rejected into a `void`
 * call and showed nothing at all (§5b).
 */
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

/**
 * The same read for a caller that is already inside a `try` — a view whose
 * failure path is one `catch` around several steps, not a branch per step.
 * Exists so "throw the sentence" is written once: it had four copies within a
 * day of `getJson` landing, and a copy that throws the `Response` instead of
 * the sentence is how `[object Object]` reaches a pane.
 */
export async function mustGetJson<T>(
  url: string,
  fallback: string,
  init?: RequestInit,
): Promise<T> {
  const got = await getJson<T>(url, fallback, init);
  if (!got.ok) throw new Error(got.error);
  return got.value;
}

/**
 * A bodiless POST or DELETE — stop a run, delete a board, retry a task — where
 * the only answer worth having is the sentence for a refusal. Three views had
 * the same try/fetch/failure/catch around it, and two of them had left the
 * catch out, so a request that never answered surfaced as an "unhandled
 * rejection" line in the chat pane instead of in the pane that was clicked.
 */
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

/**
 * Ask for one line of text and post it to a run-control endpoint.
 *
 * Both surfaces that steer a subagent — the chat's background-run row and the
 * Tasks console — had grown their own copy of this, with the first two
 * arguments in opposite orders. Both are strings, so swapping them type-checks
 * and fails at runtime.
 */
export async function promptRun(
  title: string,
  url: string,
  fields: Record<string, unknown>,
  fallback: string,
): Promise<Sent> {
  const message = window.prompt(title);
  if (!message?.trim()) return { sent: false };
  try {
    const res = await sendJson(url, { message, ...fields });
    return { sent: true, ...(res.ok ? {} : { error: await failure(res, fallback) }) };
  } catch (err) {
    return { sent: true, error: `${fallback}: ${String(err)}` };
  }
}
