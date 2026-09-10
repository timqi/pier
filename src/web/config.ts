// The agent files a scope is configured by, through the ConfigStore. Not via
// web/fs.ts: a scope is "global" or a cwd Pi already knows, never a browser path.

import type { Hono } from "hono";
import { isThinkingLevel, type AgentDefaults, type AgentFactory, type ConfigScope, type ConfigStore } from "../core/types.js";
import { normalizeModelRef } from "../settings.js";
import { guarded } from "./route.js";

export interface ConfigRouteDeps {
  factory: AgentFactory;
  config: ConfigStore;
  /** An agent file is read when a session opens; idle ones are recycled after a save. */
  onConfigWritten?: () => void;
}

export function registerConfigRoutes(
  app: Hono,
  { factory, config, onConfigWritten }: ConfigRouteDeps,
): void {
  // Only cwds Pi already knows are accepted — never an arbitrary path.
  const parseScope = async (raw: string | undefined): Promise<ConfigScope | null> => {
    if (!raw || raw === "global") return { kind: "global" };
    const known = await factory.list();
    return known.some((s) => s.cwd === raw) ? { kind: "project", cwd: raw } : null;
  };

  app.get("/api/config", async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    return c.json({
      // Where this scope's files live on disk — the UI labels "Global" with it.
      dir: scope.kind === "global" ? config.globalDir : scope.cwd,
      files: await config.listFiles(scope),
    });
  });

  guarded(app, "GET", "/api/config/files/:name", 400, async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    return c.json({ content: await config.readFile(scope, c.req.param("name")) });
  });

  guarded(app, "PUT", "/api/config/files/:name", 400, async (c) => {
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.content !== "string" || typeof body?.expected !== "string") {
      return c.json({ error: "content and expected content required" }, 400);
    }
    const name = c.req.param("name");
    await config.writeFile(scope, name, body.content, body.expected);
    onConfigWritten?.();
    return c.json({ ok: true, content: await config.readFile(scope, name) });
  });

  // settings.json is read-only as a file; its two deployment keys go through here.
  guarded(app, "GET", "/api/config/defaults", 400, async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await config.readDefaults());
  });

  guarded(app, "PUT", "/api/config/defaults", 400, async (c) => {
    const defaults = parseDefaults(await c.req.json().catch(() => null));
    if (!defaults) {
      return c.json({ error: "defaultModel must be {provider, id} or null; defaultThinkingLevel a reasoning level or null" }, 400);
    }
    await config.writeDefaults(defaults);
    onConfigWritten?.();
    return c.json(await config.readDefaults());
  });
}

/** Both fields, each stated: null is "Pi's own default", absent is a malformed body. */
function parseDefaults(body: unknown): AgentDefaults | null {
  if (typeof body !== "object" || body === null) return null;
  const { defaultModel, defaultThinkingLevel } = body as Record<string, unknown>;
  const model = defaultModel === null ? null : normalizeModelRef(defaultModel);
  if (model === null && defaultModel !== null) return null;
  if (defaultThinkingLevel !== null && !isThinkingLevel(defaultThinkingLevel)) return null;
  return { defaultModel: model, defaultThinkingLevel };
}
