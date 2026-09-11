// Settings → Vault's three routes (/api/vault*): the only place a secret is
// ever entered, and never a place it is read back — a row is replaced or
// removed, not revealed.

import type { Hono } from "hono";
import { logger } from "../log.js";
import { isVaultName, type Vault } from "../vault.js";

const log = logger("vault");

/** doctor's bound: `vt create` may sit on an approval, and the Console must not. */
const APPROVE_TIMEOUT_MS = 15_000;

/** `pending` leaves `put` running: an approval that comes later still files the
 *  row, and a failure after that still reaches the log. */
async function bounded(put: Promise<void>, name: string): Promise<"filed" | "pending"> {
  const filed = put.then(() => "filed" as const);
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), APPROVE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([filed, pending]);
    if (outcome === "pending") filed.catch((err: unknown) => log.warn(`vault put ${name} failed after the Console stopped waiting`, err));
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

export interface VaultRouteDeps {
  vault: Pick<Vault, "list" | "put" | "remove">;
  /** vt's own read-only report: the 503 for an `approve` row vt could not create. */
  doctor: () => Promise<string>;
}

export function registerVaultRoutes(app: Hono, { vault, doctor }: VaultRouteDeps): void {
  app.get("/api/vault", (c) => {
    c.header("cache-control", "no-store");
    return c.json(vault.list());
  });

  app.put("/api/vault/:name", async (c) => {
    const name = c.req.param("name");
    if (!isVaultName(name)) {
      return c.json({ error: "name must be an environment variable name: A-Z, 0-9 and _, starting with a letter, 64 at most" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as { level?: unknown; value?: unknown } | null;
    const level = body?.level;
    if (level !== "auto" && level !== "approve") return c.json({ error: "level must be auto or approve" }, 400);
    if (typeof body?.value !== "string" || !body.value) return c.json({ error: "value required" }, 400);
    try {
      if ((await bounded(vault.put(name, level, body.value), name)) === "pending") {
        return c.json({ error: "vt is waiting for approval of the new record — approve it and retry, or file the name as auto" }, 504);
      }
    } catch (err) {
      // The value is not in the message: put never echoes it.
      const reason = err instanceof Error ? err.message : String(err);
      if (level === "approve") {
        // vt's report is the repair instruction; its own failure to run is one too.
        const report = await doctor().catch((cause: unknown) => String(cause));
        return c.json({ error: `vt could not create the record (${reason}) — vt doctor: ${report.trim()}` }, 503);
      }
      if (reason.startsWith("secrets locked")) return c.json({ error: reason }, 423);
      throw err;
    }
    return c.json(vault.list().find((entry) => entry.name === name));
  });

  app.delete("/api/vault/:name", (c) => {
    const name = c.req.param("name");
    if (!vault.remove(name)) return c.json({ error: `no secret named ${name}` }, 404);
    return c.body(null, 204);
  });
}
