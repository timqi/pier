// HTTP boundary for provider configuration.

import type { Hono } from "hono";
import { isProviderApi } from "../core/types.js";
import type { ProviderInfo, ProviderManager, ProviderSetup } from "../core/types.js";
import { ProviderFlows } from "./provider-flows.js";

function safeEndpoint(endpoint: string): boolean {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function setupFrom(raw: unknown): ProviderSetup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  if (
    !id || id.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(id) ||
    name.length > 200 || endpoint.length > 2048 || !safeEndpoint(endpoint)
  ) return null;
  if (input.kind === "builtin") return { kind: "builtin", id, ...(endpoint ? { endpoint } : {}) };
  if (
    input.kind !== "custom" || !endpoint || typeof input.api !== "string" ||
    !Array.isArray(input.models) || input.models.length > 100
  ) {
    return null;
  }
  const models = input.models.flatMap((model) => {
    if (typeof model !== "object" || model === null || typeof (model as { id?: unknown }).id !== "string") {
      return [];
    }
    const modelId = (model as { id: string }).id.trim();
    if (!modelId || modelId.length > 200) return [];
    return [{ id: modelId, reasoning: (model as { reasoning?: unknown }).reasoning === true }];
  });
  if (models.length !== input.models.length || !models.length) return null;
  if (new Set(models.map((model) => model.id)).size !== models.length) return null;
  if (!isProviderApi(input.api)) return null;
  return {
    kind: "custom",
    id,
    ...(name ? { name } : {}),
    endpoint,
    api: input.api,
    models,
  };
}

export function registerProviderRoutes(app: Hono, providers: ProviderManager): void {
  const flows = new ProviderFlows(providers);
  const configure = async (setup: ProviderSetup) => {
    await providers.setup(setup);
    const provider = (await providers.providers()).find((candidate) => candidate.id === setup.id);
    if (!provider) throw new Error(`provider did not load: ${setup.id}`);
    return provider;
  };
  const requireMethod = (provider: ProviderInfo, type: "api_key" | "oauth") => {
    if (!provider.methods.some((method) => method.type === type)) {
      throw new Error(`${type} login is not available for ${provider.id}`);
    }
  };

  app.get("/api/providers", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await providers.providers());
  });

  app.post("/api/providers/setup", async (c) => {
    const body = await c.req.json().catch(() => null);
    const setup = setupFrom(body?.setup);
    const authType = body?.authType;
    if (!setup || (authType !== null && authType !== "api_key" && authType !== "oauth")) {
      return c.json({ error: "valid setup and authType required" }, 400);
    }
    try {
      if (setup.kind === "custom" && authType === "oauth") {
        return c.json({ error: "custom providers support API-key authentication" }, 400);
      }
      if (authType === null) return c.json({ ok: true, provider: await configure(setup) });

      const before = (await providers.providers()).find((candidate) => candidate.id === setup.id);
      if (setup.kind === "builtin" && !before?.builtin) {
        return c.json({ error: "unknown built-in provider" }, 400);
      }
      if (before) requireMethod(before, authType);
      const flow = await flows.start(
        setup.id,
        authType,
        async () => {
          if (!before) requireMethod(await configure(setup), authType);
        },
        async () => {
          if (before) await configure(setup);
        },
      );
      return c.json(flow, 202);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get("/api/providers/flows/:id", (c) => {
    c.header("cache-control", "no-store");
    const flow = flows.get(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "unknown authentication flow" }, 404);
  });

  app.post("/api/providers/flows/:id/respond", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      typeof body?.promptId !== "string" || typeof body?.value !== "string" ||
      body.value.length > 64 * 1024
    ) return c.json({ error: "promptId and value required (64 KiB maximum)" }, 400);
    try {
      flows.respond(c.req.param("id"), body.promptId, body.value);
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
  });

  app.post("/api/providers/flows/:id/cancel", async (c) => {
    try {
      const flow = await flows.cancel(c.req.param("id"));
      if (!flow) return c.json({ error: "authentication is finishing" }, 409);
      return flow.state === "failed" ? c.json(flow, 409) : c.json(flow);
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.post("/api/providers/:provider/logout", async (c) => {
    try {
      await providers.logout(c.req.param("provider"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });
}
