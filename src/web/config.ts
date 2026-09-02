// The agent files a scope is configured by — Pi's own config, skills and
// extensions — read and written through the ConfigStore, never as paths. A
// scope is "global" or a project cwd Pi already knows, which is why this is
// the one filesystem-shaped surface that does not go through web/fs.ts: it
// never takes a path from the browser at all.

import type { Hono } from "hono";
import type { AgentFactory, ConfigScope, ConfigStore } from "../core/types.js";
import { guarded } from "./route.js";

export interface ConfigRouteDeps {
  factory: AgentFactory;
  config: ConfigStore;
  /** An agent file is read when a session opens, so a live session still has
   *  the old one: server.ts recycles the idle ones after every save. */
  onConfigWritten?: () => void;
}

export function registerConfigRoutes(
  app: Hono,
  { factory, config, onConfigWritten }: ConfigRouteDeps,
): void {
  // Scope comes from the client as "global" or a project cwd; only cwds Pi
  // already knows (the session list) are accepted — never an arbitrary path.
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
      resources: await config.listResources(scope),
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

  // Resource names may contain slashes — query params, not path params.
  guarded(app, "GET", "/api/config/resource", 400, async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    const kind = c.req.query("kind");
    const name = c.req.query("name");
    if ((kind !== "extensions" && kind !== "skills") || !name) {
      return c.json({ error: "kind and name required" }, 400);
    }
    return c.json({ content: await config.readResource(scope, kind, name) });
  });
}
