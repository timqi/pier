// Settings → Channels HTTP surface: one document per platform, and the
// web → IM handoff beside it.

import type { Hono } from "hono";
import { isThinkingLevel, type ModelRef, type ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import { type createHandoff, HandoffError } from "./handoff.js";
import type { ChannelRuntime } from "./runtime.js";
import {
  type ChannelConfig,
  type ChatConfig,
  defaultChannelConfig,
  type HandoffRequest,
  isChannelPlatform,
} from "./types.js";

/** Stable mask: recomputable at write time, so "unchanged" is detectable. */
const maskToken = (token: string): string =>
  token ? `${"•".repeat(8)}${token.slice(-4)}` : "";

const asBool = (v: unknown): boolean => v === true;
const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const asThinking = (v: unknown): ThinkingLevel | null => (isThinkingLevel(v) ? v : null);

/** A model is a provider/id pair or nothing; a half-filled one is nothing. */
function asModel(v: unknown): ModelRef | null {
  const ref = v as Partial<ModelRef> | null;
  if (!ref || typeof ref !== "object") return null;
  const provider = asString(ref.provider);
  const id = asString(ref.id);
  return provider && id ? { provider, id } : null;
}

/** Iterates the stored list, not the payload: a chat discovered while the
 *  operator had the page open must survive their save. */
function parseChats(raw: unknown, known: ChatConfig[]): ChatConfig[] {
  if (!Array.isArray(raw)) return known;
  const edits = new Map<string, ChatConfig>();
  for (const item of raw) {
    const id = asString((item as ChatConfig)?.id);
    if (id) edits.set(id, item as ChatConfig);
  }
  return known.map((base) => {
    const edit = edits.get(base.id);
    if (!edit) return base;
    return {
      ...base,
      enabled: asBool(edit.enabled),
      requireMention: asBool(edit.requireMention),
      requireBind: asBool(edit.requireBind),
      cwd: asString(edit.cwd),
      model: asModel(edit.model),
      thinking: asThinking(edit.thinking),
    };
  });
}

export function registerChannelRoutes(
  app: Hono,
  store: ChannelStore,
  runtime: Pick<ChannelRuntime, "reload">,
  handoff: ReturnType<typeof createHandoff>,
): void {
  app.get("/api/channels/:platform", (c) => {
    const platform = c.req.param("platform");
    if (!isChannelPlatform(platform)) return c.json({ error: "unknown platform" }, 404);
    const config = store.get(platform);
    // Never hand a token back: the client only needs to know one is set.
    return c.json({
      ...config,
      token: maskToken(config.token),
      appToken: maskToken(config.appToken),
    });
  });

  app.put("/api/channels/:platform", async (c) => {
    const platform = c.req.param("platform");
    if (!isChannelPlatform(platform)) return c.json({ error: "unknown platform" }, 404);
    const body = (await c.req.json().catch(() => null)) as Partial<ChannelConfig> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
    const current = store.get(platform);
    // A token that comes back masked is the stored one, untouched.
    const kept = (incoming: string, stored: string): string =>
      !incoming || incoming === maskToken(stored) ? stored : incoming;
    const next: ChannelConfig = {
      ...defaultChannelConfig(),
      enabled: asBool(body.enabled),
      token: kept(asString(body.token), current.token),
      appToken: kept(asString(body.appToken), current.appToken),
      requireMention: asBool(body.requireMention),
      requireBind: asBool(body.requireBind),
      cwd: asString(body.cwd),
      model: asModel(body.model),
      thinking: asThinking(body.thinking),
      users: current.users,
      chats: parseChats(body.chats, current.chats),
      bindCode: current.bindCode,
    };
    store.save(platform, next);
    await runtime.reload();
    return c.json({ ok: true });
  });

  app.post("/api/channels/:platform/bind-code", (c) => {
    const platform = c.req.param("platform");
    if (!isChannelPlatform(platform)) return c.json({ error: "unknown platform" }, 404);
    return c.json(store.issueBindCode(platform));
  });

  app.delete("/api/channels/:platform/users/:id", (c) => {
    const platform = c.req.param("platform");
    if (!isChannelPlatform(platform)) return c.json({ error: "unknown platform" }, 404);
    store.unbind(platform, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/handoff/targets", (c) => c.json({ targets: handoff.targets() }));

  app.post("/api/handoff", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<HandoffRequest> | null;
    const sessionId = asString(body?.sessionId);
    const chatId = asString(body?.chatId);
    const platform = body?.platform;
    if (!sessionId || !chatId || !isChannelPlatform(platform)) return c.json({ error: "invalid body" }, 400);
    try {
      return c.json(await handoff.continueIn({ sessionId, platform, chatId }), 201);
    } catch (err) {
      if (err instanceof HandoffError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
