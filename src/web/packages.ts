// The package registry (/api/packages*) through the PackageStore seam. A file
// of its own because the registry is not agent-file editing (config.ts).

import type { Context, Hono } from "hono";
import { PackageError, type AgentFactory, type PackageErrorReason, type PackageStore, type PackageSwitch } from "../core/types.js";

export interface PackageRouteDeps {
  factory: AgentFactory;
  packages: PackageStore;
  /** Packages are read when a session opens; idle ones are recycled after a write. */
  onConfigWritten?: () => void;
}

const STATUS: Record<PackageErrorReason, 400 | 404 | 409 | 502> = {
  invalid: 400, missing: 404, busy: 409, refused: 409, unreachable: 502,
};

export function registerPackageRoutes(app: Hono, { factory, packages, onConfigWritten }: PackageRouteDeps): void {
  // Only cwds Pi already knows are accepted — never an arbitrary path.
  const knownCwd = async (raw: string | undefined): Promise<string | null | undefined> => {
    if (raw === undefined) return undefined;
    return (await factory.list()).some((s) => s.cwd === raw) ? raw : null;
  };
  /** The seam's reasons are the table's status codes; anything else is a 500 (app.onError). */
  const answer = async (c: Context, work: () => Promise<Response>): Promise<Response> => {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof PackageError)) throw err;
      return c.json({ error: err.message }, STATUS[err.reason]);
    }
  };
  const body = async (c: Context): Promise<Record<string, unknown> | null> => {
    const parsed: unknown = await c.req.json().catch(() => null);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  };
  const written = (): void => onConfigWritten?.();

  app.get("/api/packages", (c) => answer(c, async () => {
    c.header("cache-control", "no-store");
    const cwd = await knownCwd(c.req.query("cwd"));
    if (cwd === null) return c.json({ error: "unknown cwd" }, 400);
    return c.json(await packages.list(cwd));
  }));

  app.post("/api/packages", (c) => answer(c, async () => {
    const given = await body(c);
    if (typeof given?.source !== "string") return c.json({ error: "source required" }, 400);
    const pkg = await packages.install(given.source);
    written();
    return c.json({ package: pkg });
  }));

  app.post("/api/packages/remove", (c) => answer(c, async () => {
    const given = await body(c);
    if (typeof given?.source !== "string") return c.json({ error: "source required" }, 400);
    await packages.remove(given.source);
    written();
    return c.json({ ok: true });
  }));

  app.post("/api/packages/update", (c) => answer(c, async () => {
    const given = await body(c);
    if (given?.source !== undefined && typeof given.source !== "string") return c.json({ error: "source must be a string" }, 400);
    const updated = await packages.update(given?.source);
    written();
    return c.json({ packages: updated });
  }));

  app.post("/api/packages/check", (c) => answer(c, async () => c.json(await packages.checkUpdates())));

  app.put("/api/packages/resource", (c) => answer(c, async () => {
    const change = parseSwitch(await body(c));
    if (!change) return c.json({ error: "expected {source, kind: extension|skill, path, enabled, cwd?}" }, 400);
    if (change.cwd !== undefined && await knownCwd(change.cwd) === null) return c.json({ error: "unknown cwd" }, 400);
    const resource = await packages.setEnabled(change);
    written();
    return c.json(resource);
  }));
}

function parseSwitch(given: Record<string, unknown> | null): PackageSwitch | null {
  if (!given) return null;
  const { source, kind, path, enabled, cwd } = given;
  if (typeof source !== "string" || !source || typeof path !== "string" || !path) return null;
  if ((kind !== "extension" && kind !== "skill") || typeof enabled !== "boolean") return null;
  if (cwd !== undefined && typeof cwd !== "string") return null;
  return { source, kind, path, enabled, ...(cwd !== undefined ? { cwd } : {}) };
}
