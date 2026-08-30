// What a provider's answer becomes on the way to the model: sources, results,
// the queries actually searched, usage, and the text of a fetched document.
// One shape for both backends, so a tool renders its answer once instead of
// per wire format — anthropic.ts and openai.ts parse into these, and nothing
// past this file knows which one replied.

import { isObject } from "./json.js";
import { languageLabel } from "./language.js";
import type { Backend } from "./provider.js";

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult extends Source {
  pageAge?: string;
}

/**
 * The one reader of a cited page, wherever it turns up: an Anthropic search
 * result, a citation on a text block, a fetch result, an OpenAI action source.
 * All four spell it `{url, title?}` (OpenAI sometimes as a bare string), all
 * four had their own copy of this, and they disagreed about the fallback
 * title. Keyed by url; the first real title wins over a url used as one.
 */
export function putSource(into: Map<string, SearchResult>, value: unknown): void {
  const url = typeof value === "string"
    ? value
    : isObject(value) && typeof value.url === "string"
    ? value.url
    : undefined;
  if (!url) return;
  const source = isObject(value) ? value : {};
  const titled = typeof source.title === "string" && source.title;
  const existing = into.get(url);
  if (existing && (!titled || existing.title !== existing.url)) return;
  into.set(url, {
    title: titled || url,
    url,
    ...(typeof source.page_age === "string" ? { pageAge: source.page_age } : {}),
  });
}

export interface FetchedDocument {
  url?: string;
  retrievedAt?: string;
  text?: string;
}

export interface SearchQuery {
  query: string;
  language: string;
}

/** What a sub-call cost, summed across its rounds. Reported because the caller
 *  pays for a model turn it never named. */
export interface Usage {
  input: number;
  output: number;
}

/** What both backends reduce to, so the tools stay backend-agnostic. */
export interface SearchOutcome {
  text: string;
  queries: SearchQuery[];
  results: SearchResult[];
  model: string;
  backend: Backend;
  /** The briefing hit the output ceiling and stops mid-sentence. */
  truncated: boolean;
  usage: Usage;
  /** Server-tool failures the call survived (an unavailable search, a fourth
   *  one refused). Beside the results, never instead of them. */
  errors: string[];
}

/** Everything the answer cited: what a fetch was allowed to say it read. */
export function sourcesFrom(content: unknown[]): Source[] {
  const sources = new Map<string, SearchResult>();
  const add = (value: unknown): void => putSource(sources, value);
  for (const block of content) {
    if (!isObject(block)) continue;
    if (Array.isArray(block.citations)) block.citations.forEach(add);
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      block.content.forEach(add);
    }
    if (block.type === "web_fetch_tool_result" && isObject(block.content)) add(block.content);
  }
  return [...sources.values()].map(({ title, url }) => ({ title, url }));
}

/** Only what the search itself returned, in the order it ranked them. */
export function searchResultsFrom(content: unknown[]): SearchResult[] {
  const results = new Map<string, SearchResult>();
  for (const block of content) {
    if (!isObject(block) || block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue;
    for (const item of block.content) putSource(results, item);
  }
  return [...results.values()];
}

export function searchQueriesFrom(content: unknown[]): SearchQuery[] {
  const queries: SearchQuery[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "server_tool_use" || block.name !== "web_search") {
      continue;
    }
    if (!isObject(block.input) || typeof block.input.query !== "string") continue;
    queries.push({ query: block.input.query, language: languageLabel(block.input.query) });
  }
  return queries;
}

export function searchOutcomeFrom(
  content: unknown[],
  model: string,
  backend: Backend,
  spent: { stopReason?: string; usage: Usage; errors: string[] },
): SearchOutcome {
  return {
    text: textFrom(content),
    queries: searchQueriesFrom(content),
    results: searchResultsFrom(content),
    model,
    backend,
    truncated: spent.stopReason === "max_tokens",
    usage: spent.usage,
    errors: spent.errors,
  };
}

export function textFrom(content: unknown[]): string {
  return content
    .filter(
      (block): block is { text: string } =>
        isObject(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

export function fetchedDocument(content: unknown[]): FetchedDocument {
  for (const block of content) {
    if (!isObject(block) || block.type !== "web_fetch_tool_result") continue;
    if (!isObject(block.content)) continue;
    const result = block.content;
    if (result.type !== "web_fetch_result" || !isObject(result.content)) continue;
    const source = isObject(result.content.source) ? result.content.source : undefined;
    return {
      url: typeof result.url === "string" ? result.url : undefined,
      retrievedAt: typeof result.retrieved_at === "string" ? result.retrieved_at : undefined,
      text:
        source?.type === "text" && typeof source.data === "string"
          ? source.data
          : undefined,
    };
  }
  return {};
}

export function appendSources(text: string, sources: Source[]): string {
  if (!sources.length) return text;
  return `${text}\n\nSources:\n${sources.map(({ title, url }) => `- [${title}](${url})`).join("\n")}`;
}

export function formatSearchResult(
  briefing: string,
  results: SearchResult[],
  maxResults: number,
  queries: SearchQuery[],
): string {
  const queryList = queries
    .map(({ query, language }, index) => `${index + 1}. [${language}] ${query}`)
    .join("\n");
  const listing = results
    .slice(0, maxResults)
    .map(
      (result, index) =>
        `${index + 1}. [${result.title}](${result.url})${result.pageAge ? ` — ${result.pageAge}` : ""}`,
    )
    .join("\n");
  return [
    briefing,
    queryList ? `Queries used:\n${queryList}` : "",
    listing ? `Search results:\n${listing}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
