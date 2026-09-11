// Settings → Vault's three routes (/api/vault*): the only place a secret is
// ever entered, and never a place it is read back — a row is replaced or
// removed, not revealed.

import type { Hono } from "hono";
import { isVaultName, type Vault } from "../vault.js";

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
      await vault.put(name, level, body.value);
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
