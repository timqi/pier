import { putSource, type SearchOutcome, type SearchQuery, type SearchResult } from "./content.js";
import { HttpError, postJson } from "./http.js";
import { isObject, type JsonObject } from "./json.js";
import { languageLabel } from "./language.js";
import type { RequestTarget } from "./provider.js";

/** OpenAI Responses wire format for the hosted web_search tool. */

interface WebSearchOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

function parse(data: Record<string, unknown>, output: unknown[], model: string): SearchOutcome {
  const queries: SearchQuery[] = [];
  const results = new Map<string, SearchResult>();
  const texts: string[] = [];

  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === "web_search_call") {
      const action = isObject(item.action) ? item.action : undefined;
      const raw = [
        ...(typeof action?.query === "string" ? [action.query] : []),
        ...(Array.isArray(action?.queries) ? action.queries : []),
      ];
      for (const query of raw) {
        if (typeof query === "string" && !queries.some((q) => q.query === query)) {
          queries.push({ query, language: languageLabel(query) });
        }
      }
      // Plain URLs on some deployments, objects on others; putSource takes both.
      if (Array.isArray(action?.sources)) action.sources.forEach((s) => putSource(results, s));
      if (Array.isArray(item.results)) item.results.forEach((r) => putSource(results, r));
      continue;
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObject(part) || part.type !== "output_text") continue;
      if (typeof part.text === "string") texts.push(part.text);
      if (Array.isArray(part.annotations)) {
        for (const annotation of part.annotations) {
          if (isObject(annotation) && annotation.type === "url_citation") {
            putSource(results, annotation);
          }
        }
      }
    }
  }

  // Responses reports a cut-off answer as a status, not a stop reason.
  const incomplete = isObject(data.incomplete_details) ? data.incomplete_details : {};
  const usage = isObject(data.usage) ? data.usage : {};
  const count = (field: unknown): number => (typeof field === "number" ? field : 0);
  return {
    text: texts.join("\n\n").trim(),
    queries,
    results: [...results.values()],
    model,
    backend: "openai",
    truncated: data.status === "incomplete" && incomplete.reason === "max_output_tokens",
    usage: { input: count(usage.input_tokens), output: count(usage.output_tokens) },
    // Responses has no per-invocation server-tool error to report: a hosted
    // search that fails fails the request.
    errors: [],
  };
}

export async function webSearchViaResponses(
  request: RequestTarget,
  prompt: string,
  options: WebSearchOptions,
  signal?: AbortSignal,
  /** Progress for the surface the call came from (§5b). */
  note?: (text: string) => void,
): Promise<SearchOutcome> {
  const tool: JsonObject = { type: "web_search" };
  const filters: JsonObject = {};
  if (options.allowedDomains?.length) filters.allowed_domains = options.allowedDomains;
  if (options.blockedDomains?.length) filters.blocked_domains = options.blockedDomains;
  if (Object.keys(filters).length) tool.filters = filters;

  // Hosted-tool forcing is not accepted by every OpenAI-compatible gateway; on a
  // rejected request fall back to "auto" rather than losing the search entirely.
  let forced: HttpError | undefined;
  for (const toolChoice of [{ type: "web_search" }, "auto"] as const) {
    let data: Record<string, unknown>;
    try {
      data = await postJson(
        "OpenAI",
        request.url,
        request.headers,
        {
          model: request.model,
          max_output_tokens: request.maxTokens,
          input: prompt,
          tools: [tool],
          tool_choice: toolChoice,
          include: ["web_search_call.action.sources"],
        },
        signal,
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 400 && toolChoice !== "auto") {
        forced = error;
        note?.("this endpoint refused a forced hosted tool — asking again with tool_choice=auto");
        continue;
      }
      // Never let the retry hide why the first attempt was rejected.
      if (forced) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (forced tool_choice also failed — ${forced.message})`);
      }
      throw error;
    }
    if (!Array.isArray(data.output)) {
      throw new Error("OpenAI returned an invalid Responses payload");
    }
    const outcome = parse(data, data.output, request.model);
    if (!outcome.queries.length && !outcome.results.length) {
      throw new Error("The model did not invoke web_search");
    }
    return outcome;
  }
  throw new Error(`OpenAI rejected the web_search request${forced ? ` — ${forced.message}` : ""}`);
}
