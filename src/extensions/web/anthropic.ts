import type { Usage } from "./content.js";
import { postJson } from "./http.js";
import { isObject, type JsonObject } from "./json.js";
import type { RequestTarget } from "./provider.js";

/** Anthropic Messages wire format for the hosted web_search / web_fetch server tools. */

export type NativeToolName = "web_search" | "web_fetch";

interface NativeToolOptions {
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** web_fetch only, and always passed: a second default here would be a
   *  second answer to "how much of a page" that nothing ever reads. */
  maxContentTokens?: number;
}

interface NativeToolResponse {
  content: unknown[];
  model: string;
  /** `"max_tokens"` means the answer stops mid-sentence. Returned rather than
   *  swallowed: a cut-off briefing reads exactly like a complete one. */
  stopReason?: string;
  usage: Usage;
  /** Server-tool failures that did not sink the call — one search of three
   *  came back `unavailable`, the model asked for a fourth and got
   *  `max_uses_exceeded`. Reported beside the results, not instead of them. */
  errors: string[];
}

const tokensFrom = (value: unknown): Usage => {
  const usage = isObject(value) ? value : {};
  const count = (field: unknown): number => (typeof field === "number" ? field : 0);
  return { input: count(usage.input_tokens), output: count(usage.output_tokens) };
};

const NATIVE_TOOL_TYPES: Record<NativeToolName, string> = {
  web_search: "web_search_20250305",
  web_fetch: "web_fetch_20250910",
};

const findCode = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = findCode(item);
      if (code) return code;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  return typeof value.error_code === "string" ? value.error_code : findCode(value.content);
};

/**
 * Every server-tool failure in the turn. A list, not the first one, and not a
 * throw: these arrive per invocation — the third search can fail while the
 * first two are in the transcript and the briefing is written from them. This
 * used to abort the whole call on any of them, which threw away a good answer
 * over `max_uses_exceeded`, a code we provoke ourselves by budgeting the
 * searches the prompt then asks for.
 */
function toolErrors(content: unknown[]): string[] {
  const codes: string[] = [];
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== "string") continue;
    if (!block.type.endsWith("_tool_result")) continue;
    const code = findCode(block.content);
    if (code) codes.push(`${block.type}: ${code}`);
  }
  return [...new Set(codes)];
}

/** Whether anything usable came back at all: prose the model wrote, or a tool
 *  result that is not itself an error. This is what decides failure now. */
function hasContent(content: unknown[]): boolean {
  return content.some((block) => {
    if (!isObject(block) || typeof block.type !== "string") return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== "";
    if (!block.type.endsWith("_tool_result")) return false;
    return findCode(block.content) === undefined;
  });
}

export async function callNativeTool(
  request: RequestTarget,
  name: NativeToolName,
  prompt: string,
  options: NativeToolOptions,
  signal?: AbortSignal,
  /** Progress for the surface the call came from: a hosted search is tens of
   *  seconds of nothing otherwise (§5b). */
  note?: (text: string) => void,
): Promise<NativeToolResponse> {
  const tool: JsonObject = {
    type: NATIVE_TOOL_TYPES[name],
    name,
    max_uses: options.maxUses,
  };
  if (options.allowedDomains?.length) tool.allowed_domains = options.allowedDomains;
  if (options.blockedDomains?.length) tool.blocked_domains = options.blockedDomains;
  if (name === "web_fetch") {
    tool.citations = { enabled: true };
    tool.max_content_tokens = options.maxContentTokens ?? 20_000;
  }

  const messages: JsonObject[] = [{ role: "user", content: prompt }];
  const accumulated: unknown[] = [];
  const spent: Usage = { input: 0, output: 0 };
  for (let continuation = 0; continuation < 3; continuation++) {
    if (continuation) note?.(`still working — round ${continuation + 1}`);
    const data = await postJson(
      "Anthropic",
      request.url,
      request.headers,
      {
        model: request.model,
        max_tokens: request.maxTokens,
        messages,
        tools: [tool],
        ...(continuation === 0 ? { tool_choice: { type: "tool", name } } : {}),
      },
      signal,
    );
    if (!Array.isArray(data.content)) {
      throw new Error("Anthropic returned an invalid Messages response");
    }

    accumulated.push(...data.content);
    const round = tokensFrom(data.usage);
    spent.input += round.input;
    spent.output += round.output;
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    const errors = toolErrors(accumulated);
    const used = accumulated.some(
      (block) =>
        isObject(block) &&
        (block.type === "server_tool_use" || block.type === `${name}_tool_result`),
    );
    // Only now, with the whole turn in hand, is "this failed" answerable.
    if (!used) throw new Error(errors.join("; ") || `Claude did not invoke ${name}`);
    if (!hasContent(accumulated)) {
      throw new Error(errors.join("; ") || `${name} returned nothing usable`);
    }
    return {
      content: accumulated,
      model: request.model,
      ...(typeof data.stop_reason === "string" ? { stopReason: data.stop_reason } : {}),
      usage: spent,
      errors,
    };
  }
  throw new Error(`${name} exceeded the continuation limit`);
}
