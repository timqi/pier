// Relay one Pi provider-owned login interaction through short-lived in-memory state.

import { randomUUID } from "node:crypto";
import type {
  ProviderAuthEvent,
  ProviderAuthPrompt,
  ProviderAuthType,
  ProviderManager,
} from "../core/types.js";
import { logger } from "../log.js";

const log = logger("web.providers");
const FLOW_TTL_MS = 10 * 60_000;
const TERMINAL_TTL_MS = 60_000;
const MAX_EVENTS = 100;
const MAX_TEXT = 4_096;

interface PendingPrompt {
  id: string;
  /** Select answers are option ids, not secrets — scrubbing a short common
   *  id like "1" would splatter [redacted] through every later message. */
  redact: boolean;
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

type VisiblePrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    };

const text = (value: unknown, max = MAX_TEXT): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const scrub = (value: unknown, secrets: readonly string[], max = MAX_TEXT): string => {
  let visible = typeof value === "string" ? value : "";
  for (const secret of secrets) if (secret) visible = visible.replaceAll(secret, "[redacted]");
  return visible.slice(0, max);
};

function visibleEvent(event: ProviderAuthEvent, secrets: readonly string[]): ProviderAuthEvent | null {
  if (event.type === "info") {
    const message = scrub(event.message, secrets);
    if (!message) return null;
    const links = event.links?.slice(0, 20).flatMap((link) => {
      const url = scrub(link.url, secrets, 4_096);
      return url ? [{ url, ...(link.label ? { label: scrub(link.label, secrets, 500) } : {}) }] : [];
    });
    return { type: "info", message, ...(links?.length ? { links } : {}) };
  }
  if (event.type === "auth_url") {
    const url = scrub(event.url, secrets, 4_096);
    return url ? {
      type: "auth_url",
      url,
      ...(event.instructions ? { instructions: scrub(event.instructions, secrets) } : {}),
    } : null;
  }
  if (event.type === "device_code") {
    const userCode = scrub(event.userCode, secrets, 500);
    const verificationUri = scrub(event.verificationUri, secrets, 4_096);
    return userCode && verificationUri ? {
      type: "device_code",
      userCode,
      verificationUri,
      ...(typeof event.intervalSeconds === "number" ? { intervalSeconds: event.intervalSeconds } : {}),
      ...(typeof event.expiresInSeconds === "number" ? { expiresInSeconds: event.expiresInSeconds } : {}),
    } : null;
  }
  const message = scrub(event.message, secrets);
  return message ? { type: "progress", message } : null;
}

function visiblePrompt(prompt: ProviderAuthPrompt): VisiblePrompt {
  const message = text(prompt.message);
  if (!message) throw new Error("provider returned an invalid prompt");
  if (prompt.type === "select") {
    const options = prompt.options.slice(0, 100).flatMap((option) => {
      const id = text(option.id, 500);
      const label = text(option.label, 500);
      return id && label
        ? [{ id, label, ...(option.description ? { description: text(option.description, 1_000) } : {}) }]
        : [];
    });
    if (!options.length) throw new Error("provider returned an invalid select prompt");
    return { type: "select", message, options };
  }
  return {
    type: prompt.type,
    message,
    ...(prompt.placeholder ? { placeholder: text(prompt.placeholder, 500) } : {}),
  };
}

interface Flow {
  id: string;
  providerId: string;
  type: ProviderAuthType;
  state: "running" | "succeeded" | "failed" | "cancelled";
  events: ProviderAuthEvent[];
  prompt?: VisiblePrompt & { id: string };
  error?: string;
  controller: AbortController;
  pending?: PendingPrompt;
  redactions: string[];
  committing: boolean;
  run?: Promise<void>;
  expires?: ReturnType<typeof setTimeout>;
}

const snapshot = ({
  controller: _controller,
  pending: _pending,
  redactions: _redactions,
  committing: _committing,
  run: _run,
  expires: _expires,
  ...flow
}: Flow) => flow;
export type ProviderFlow = ReturnType<typeof snapshot>;

export class ProviderFlows {
  readonly #flows = new Map<string, Flow>();

  constructor(private readonly providers: ProviderManager) {}

  async start(
    providerId: string,
    type: ProviderAuthType,
    prepare: () => Promise<void> = () => Promise.resolve(),
    complete: () => Promise<void> = () => Promise.resolve(),
  ): Promise<ProviderFlow> {
    if ([...this.#flows.values()].some((flow) => flow.providerId === providerId && flow.state === "running")) {
      throw new Error(`authentication already running for ${providerId}`);
    }
    const flow: Flow = {
      id: randomUUID(),
      providerId,
      type,
      state: "running",
      events: [],
      controller: new AbortController(),
      redactions: [],
      committing: false,
    };
    flow.expires = setTimeout(() => this.#expire(flow), FLOW_TTL_MS);
    flow.expires.unref();
    this.#flows.set(flow.id, flow);
    try {
      await prepare();
    } catch (err) {
      clearTimeout(flow.expires);
      this.#flows.delete(flow.id);
      throw err;
    }
    if (!this.#flows.has(flow.id)) throw new Error("authentication flow expired during setup");
    flow.run = this.#run(flow, complete);
    return snapshot(flow);
  }

  get(id: string): ProviderFlow | undefined {
    const flow = this.#flows.get(id);
    return flow ? snapshot(flow) : undefined;
  }

  respond(id: string, promptId: string, value: string): void {
    const flow = this.#require(id);
    if (flow.state !== "running" || !flow.pending || flow.pending.id !== promptId) {
      throw new Error("prompt is no longer waiting for a response");
    }
    const pending = flow.pending;
    flow.pending = undefined;
    flow.prompt = undefined;
    pending.cleanup();
    if (value && pending.redact) flow.redactions.push(value.slice(0, 64 * 1024));
    pending.resolve(value);
  }

  async cancel(id: string): Promise<ProviderFlow | null> {
    const flow = this.#require(id);
    if (flow.state !== "running") return snapshot(flow);
    if (flow.committing) return null;
    flow.controller.abort();
    this.#settlePrompt(flow, new Error("Login cancelled"));
    // A provider that ignores its abort signal must not park this request —
    // the flow then settles (or expires) in the background instead.
    await Promise.race([flow.run, new Promise((r) => setTimeout(r, 2_000).unref())]);
    return snapshot(flow);
  }

  async #run(flow: Flow, complete: () => Promise<void>): Promise<void> {
    let rollback: (() => Promise<void>) | undefined;
    try {
      rollback = await this.providers.login(flow.providerId, flow.type, {
        signal: flow.controller.signal,
        prompt: (prompt) => this.#prompt(flow, prompt),
        notify: (event) => {
          const visible = visibleEvent(event, flow.redactions);
          if (!visible) return;
          flow.events.push(visible);
          if (flow.events.length > MAX_EVENTS) flow.events.shift();
        },
      });
      flow.controller.signal.throwIfAborted();
      flow.committing = true;
      await complete();
      flow.committing = false;
      this.#finish(flow, "succeeded");
    } catch (err) {
      flow.committing = false;
      let failure = err;
      if (rollback) {
        try {
          await rollback();
        } catch (rollbackError) {
          failure = new AggregateError([err, rollbackError], "provider login rollback failed");
        }
      }
      if (flow.state !== "running") return;
      if (flow.controller.signal.aborted && failure === err) this.#finish(flow, "cancelled");
      else {
        const error = this.#safeError(flow, failure);
        log.warn(`provider login failed for ${flow.providerId}: ${error}`);
        this.#finish(flow, "failed", error);
      }
    }
  }

  #prompt(flow: Flow, prompt: ProviderAuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
    if (flow.pending) return Promise.reject(new Error("provider requested overlapping prompts"));
    const visible = visiblePrompt(prompt);
    const { signal } = prompt;
    const id = randomUUID();
    flow.prompt = { ...visible, id };
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        if (flow.pending?.id !== id) return;
        flow.pending = undefined;
        flow.prompt = undefined;
        reject(new Error("Prompt cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      flow.pending = { id, redact: visible.type !== "select", resolve, reject, cleanup };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #settlePrompt(flow: Flow, error: Error): void {
    const pending = flow.pending;
    flow.pending = undefined;
    flow.prompt = undefined;
    pending?.cleanup();
    pending?.reject(error);
  }

  #finish(flow: Flow, state: "succeeded" | "failed" | "cancelled", error?: string): void {
    if (flow.state !== "running") return;
    clearTimeout(flow.expires);
    this.#settlePrompt(flow, new Error("Login finished"));
    flow.state = state;
    flow.error = error;
    flow.events = [];
    flow.redactions = [];
    flow.expires = setTimeout(() => this.#flows.delete(flow.id), TERMINAL_TTL_MS);
    flow.expires.unref();
  }

  #safeError(flow: Flow, err: unknown): string {
    return scrub(String(err), flow.redactions);
  }

  #require(id: string): Flow {
    const flow = this.#flows.get(id);
    if (!flow) throw new Error("unknown authentication flow");
    return flow;
  }

  #expire(flow: Flow): void {
    if (flow.committing) {
      flow.expires = setTimeout(() => this.#expire(flow), 1_000);
      flow.expires.unref();
      return;
    }
    if (flow.state === "running") {
      flow.controller.abort();
      this.#settlePrompt(flow, new Error("Login expired"));
      flow.state = "cancelled";
    }
    flow.events = [];
    flow.redactions = [];
    this.#flows.delete(flow.id);
  }
}
