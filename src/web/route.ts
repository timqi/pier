// A route body that throws answers as JSON — the one shape every view's
// fetch helper already knows how to read, with the status the route owns.
// It lives alone because all three route families use it and none of them is
// where the other two would look for it.

import type { Context, Env, Hono } from "hono";

/** Register a route whose body may throw: the error becomes the JSON shape
 *  the UI expects, with the status the route owns. Takes the literal path so
 *  `c.req.param()` keeps its typed keys. */
export function guarded<P extends string>(
  app: Hono,
  method: "GET" | "POST" | "PUT",
  path: P,
  status: 400 | 404,
  fn: (c: Context<Env, P>) => Promise<Response>,
): void {
  app.on(method, path, async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      return c.json({ error: String(err) }, status);
    }
  });
}
