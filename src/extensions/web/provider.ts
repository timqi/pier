import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isObject } from "./json.js";

/**
 * Turns a call into an authenticated request target on one of the hosted web
 * backends.
 *
 * Why this file exists at all — why not `ctx.modelRegistry.complete()`, which
 * already knows every provider's URL and auth: because a hosted server tool is
 * not a tool in Pi's sense. `web_search_20250305` is a *provider* feature,
 * declared in the request body and executed inside the provider's own turn;
 * nothing in the SDK's tool abstraction can express it, so reaching it means
 * speaking Messages or Responses ourselves. The cost is this file: an endpoint
 * derived from a base URL, and auth headers assembled from what the registry
 * resolved. That is also where a non-standard gateway breaks first — if a proxy
 * serves Messages at a path that is not `<base>/v1/messages`, `endpoint()`
 * below guesses wrong, and the fix belongs here rather than in the tools.
 */

// Taken from the registry rather than imported from pi-ai: the model type is
// whatever the SDK we are loaded by hands out, and Pier does not depend on
// pi-ai directly.
type RegistryModel = ReturnType<ModelRegistry["getAll"]>[number];

export type Backend = "anthropic" | "openai";

export interface RequestTarget {
  backend: Backend;
  url: string;
  headers: Headers;
  model: string;
  maxTokens: number;
}

const BACKEND_API: Record<Backend, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
};

const DEFAULT_MODEL: Record<Backend, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.6",
};

/** The one escape hatch: an endpoint that has neither default model. */
const CONFIGURED_MODEL = process.env.PIER_WEB_MODEL?.trim();

/**
 * Candidates for a backend, best first: the configured tool model, the
 * backend's cheap default, then the session's own model when it happens to be
 * on the right API. Every one of those is a model somebody named — there is
 * deliberately no "any other model on this API" step, because the model a
 * search runs on decides its cost, its refusals and its results, and picking
 * an unnamed one on the user's behalf is how a search ends up on whatever
 * unreleased id a gateway happened to list first.
 */
function candidates(ctx: ExtensionContext, backend: Backend): RegistryModel[] {
  const api = BACKEND_API[backend];
  const registry = ctx.modelRegistry;
  const onApi = registry.getAll().filter((model) => model.api === api);
  const named = [CONFIGURED_MODEL, DEFAULT_MODEL[backend]].filter((id) => Boolean(id));
  const active = ctx.model?.api === api ? [ctx.model] : [];
  const ordered = [...named.flatMap((id) => onApi.filter((model) => model.id === id)), ...active];
  const seen = new Set<string>();
  return ordered.filter((model) => {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return registry.hasConfiguredAuth(model);
  });
}

function mergeHeaders(target: Headers, source: unknown): void {
  if (!isObject(source)) return;
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") target.set(name, value);
    else if (value === null) target.delete(name);
  }
}

function hasAuthHeader(headers: Headers): boolean {
  return ["authorization", "x-api-key", "cf-aig-authorization"].some((name) => headers.has(name));
}

function endpoint(backend: Backend, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = backend === "anthropic" ? "messages" : "responses";
  if (base.endsWith(`/v1/${path}`)) return base;
  if (base.endsWith("/v1")) return `${base}/${path}`;
  return `${base}/v1/${path}`;
}

async function target(
  ctx: ExtensionContext,
  backend: Backend,
  model: RegistryModel,
  outputTokens: number,
): Promise<RequestTarget> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const headers = new Headers();
  mergeHeaders(headers, model.headers);
  mergeHeaders(headers, auth.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  if (backend === "anthropic" && !headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }
  if (auth.apiKey && !hasAuthHeader(headers)) {
    const oauth = auth.apiKey.startsWith("sk-ant-oat");
    if (backend === "anthropic" && !oauth) headers.set("x-api-key", auth.apiKey);
    else headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  if (!hasAuthHeader(headers)) throw new Error(`No ${backend} authentication resolved`);

  const limit = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : 4096;
  // Responses spends reasoning tokens out of `max_output_tokens` too, so the
  // same budget buys a fraction of the prose there — a reasoning model can burn
  // the lot and return an empty answer. The caller asks for what it wants to
  // read; this is the one place that knows which wire it goes out on.
  const wanted = backend === "openai" ? outputTokens * 2 : outputTokens;
  return {
    backend,
    url: endpoint(backend, auth.baseUrl || model.baseUrl || ""),
    headers,
    model: model.id,
    maxTokens: Math.max(128, Math.min(wanted, limit)),
  };
}

/**
 * `capable` narrows the backends that can serve the call — web_fetch is an
 * Anthropic-only server tool, so it passes ["anthropic"]. `requested` is the
 * caller's explicit choice; without one both are tried in order.
 */
export async function resolveTarget(
  ctx: ExtensionContext,
  outputTokens: number,
  capable: Backend[] = ["anthropic", "openai"],
  requested?: Backend,
): Promise<RequestTarget> {
  const wanted = (requested ? [requested] : capable).filter((backend) => capable.includes(backend));
  if (!wanted.length) {
    throw new Error(`backend="${requested}" cannot serve this tool (needs ${capable.join(" or ")})`);
  }
  const failures: string[] = [];
  for (const backend of wanted) {
    const [model] = candidates(ctx, backend);
    if (!model) {
      // Naming the repair: the search does not silently move to another model.
      failures.push(
        `${backend}: authenticate ${DEFAULT_MODEL[backend]} on an ${BACKEND_API[backend]} ` +
          `provider, or set PIER_WEB_MODEL to a model you have there`,
      );
      continue;
    }
    try {
      return await target(ctx, backend, model, outputTokens);
    } catch (error) {
      failures.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No web backend available — ${failures.join("; ")}`);
}
