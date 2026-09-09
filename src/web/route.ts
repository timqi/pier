// A route body that throws answers as JSON, the shape every view's fetch
// helper reads, with the status the route owns.

import type { Context, Env, Hono } from "hono";

/** Takes the literal path so `c.req.param()` keeps its typed keys. */
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
