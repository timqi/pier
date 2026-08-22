// The one shape every JSON write shares — nine modules had grown their own
// copy of the same method/headers/body triple.

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
