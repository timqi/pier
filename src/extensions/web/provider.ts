import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isObject } from "./json.js";

/** Not `ctx.modelRegistry.complete()`: a hosted server tool is a *provider*
 *  feature declared in the request body, which Pi's tool abstraction cannot
 *  express, so Messages/Responses are spoken here. A gateway serving Messages
 *  off `<base>/v1/messages` breaks in `endpoint()` first. */

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

/** Every candidate is a model somebody named; no "any other model on this API"
 *  step, or a search ends up on whatever unreleased id a gateway listed first. */
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
  // Responses spends reasoning tokens out of `max_output_tokens` too; a
  // reasoning model can burn the lot and return an empty answer.
  const wanted = backend === "openai" ? outputTokens * 2 : outputTokens;
  return {
    backend,
    url: endpoint(backend, auth.baseUrl || model.baseUrl || ""),
    headers,
    model: model.id,
    maxTokens: Math.max(128, Math.min(wanted, limit)),
  };
}

/** `capable`: web_fetch is an Anthropic-only server tool. */
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
