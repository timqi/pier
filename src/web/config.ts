// The global agent files, through the ConfigStore. Not via web/fs.ts: a file is
// named from the store's whitelist, never a browser path.

import type { Hono } from "hono";
import { isThinkingLevel } from "../core/types.js";
import { SNAPSHOT_FILES, type AgentDefaults, type ConfigStore } from "../agent/types.js";
import { normalizeModelRef } from "../settings.js";
import { managedRefusal } from "./config-sync.js";
import { guarded } from "./route.js";

interface ConfigRouteDeps {
  config: ConfigStore;
  /** An agent file is read when a session opens; idle ones are recycled after a save. */
  onConfigWritten?: () => void;
  /** The configuration subscription is on: the global files it carries and
   *  the defaults are the source's, refused here. */
  subscribed?: () => boolean;
}

export function registerConfigRoutes(
  app: Hono,
  { config, onConfigWritten, subscribed = () => false }: ConfigRouteDeps,
): void {
  const managed = (name: string): boolean => subscribed() && (SNAPSHOT_FILES as readonly string[]).includes(name);

  app.get("/api/config", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      // Where the files live on disk, which moves with PIER_HOME — the UI names it.
      dir: config.globalDir,
      files: (await config.listFiles()).map((file) => ({ ...file, managed: managed(file.name) })),
    });
  });

  guarded(app, "GET", "/api/config/files/:name", 400, async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ content: await config.readFile(c.req.param("name")) });
  });

  guarded(app, "PUT", "/api/config/files/:name", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.content !== "string" || typeof body?.expected !== "string") {
      return c.json({ error: "content and expected content required" }, 400);
    }
    const name = c.req.param("name");
    if (managed(name)) return managedRefusal(c);
    await config.writeFile(name, body.content, body.expected);
    onConfigWritten?.();
    return c.json({ ok: true, content: await config.readFile(name) });
  });

  // settings.json is read-only as a file; its two deployment keys go through here.
  guarded(app, "GET", "/api/config/defaults", 400, async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await config.readDefaults());
  });

  guarded(app, "PUT", "/api/config/defaults", 400, async (c) => {
    if (subscribed()) return managedRefusal(c);
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
