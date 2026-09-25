// The one fake AgentSession every area's tests share, so no test passes against
// a double that no longer behaves like agent/pi.ts at the seam: a state event on
// every transition, Pi's event order within a turn, and system inputs handed to
// a streaming session held in Pi's queue — invisible to the transcript — until
// the turn drains them. Pi's text queue (steer, followUp) is held until cleared;
// no test drives a queued message through a turn.

import type {
  AgentSession,
  ChatTurn,
  ContextUsage,
  ModelRef,
  SessionEventPayload,
  SessionState,
  SystemInputOrigin,
  ThinkingLevel,
} from "./types.js";

type Mode = "prompt" | "steer" | "followUp" | "append";
type Queue = { steering: string[]; followUp: string[] };

export interface FakeSessionOptions {
  /** What every turn answers. */
  reply?: string;
  /** Every turn ends the way a provider outage ends one: no text, this reason. */
  error?: string;
  /** A turn keeps streaming until `abort()`. */
  hold?: boolean;
  /** The test plays Pi's side: prompt, steer, followUp and systemInput only
   *  record, and every event is the test's own `emit`. */
  scripted?: boolean;
  /** The transcript before any turn. */
  history?: ChatTurn[];
  queue?: Partial<Queue>;
  model?: ModelRef;
  /** What `availableModels` offers and `setModel` accepts; the model alone by default. */
  models?: ModelRef[];
  thinkingLevel?: ThinkingLevel;
  levels?: ThinkingLevel[];
  contextUsage?: ContextUsage;
}

export type FakeSession = AgentSession & {
  /** Every call that changes the session, as `name` or `name:argument`, in order. */
  calls: string[];
  /** The text of every `prompt`. */
  prompts: string[];
  /** Everything handed to `systemInput`, queued or not. */
  systemInputs: { text: string; origin: SystemInputOrigin; mode: Mode }[];
  emit(event: SessionEventPayload): void;
  /** A turn this fake does not run — the user's, say — starts or ends; ending
   *  it drains queued system inputs into the transcript first, as Pi does. */
  setState(state: SessionState): void;
  /** Park texts in Pi's queue without an event, as an abort leaves them. */
  setQueue(queue: Partial<Queue>): void;
  /** The running turn reaches a tool boundary: Pi injects queued steers. */
  deliverSteering(): void;
};

export function fakeSession(id = "s1", opts: FakeSessionOptions = {}): FakeSession {
  const reply = opts.error ? "" : opts.reply ?? "agent result";
  let state: SessionState = "idle";
  let model = opts.model ?? { provider: "test", id: "model" };
  const models = opts.models ?? [model];
  let thinkingLevel = opts.thinkingLevel ?? "off";
  const transcript: ChatTurn[] = [...(opts.history ?? [])];
  let queue: Queue = { steering: [], followUp: [], ...opts.queue };
  const queuedInputs: { text: string; origin: SystemInputOrigin; mode: Mode }[] = [];
  const listeners = new Set<(event: SessionEventPayload) => void>();
  /** Releases the held turn, if any. */
  let release: (() => void) | undefined;

  const emit = (event: SessionEventPayload): void => listeners.forEach((fn) => fn(event));
  const transition = (next: SessionState): void => {
    state = next;
    emit({ type: "state", state: next });
  };
  // What agent/events.ts makes of a message entering the context.
  const enter = (input: { text: string; origin?: SystemInputOrigin }): void => {
    const at = Date.now();
    emit({ type: "turn-start" });
    if (input.origin) {
      transcript.push({ role: "system", text: input.text, origin: input.origin, at });
      emit({ type: "system-input", text: input.text, origin: input.origin, at });
    } else {
      transcript.push({ role: "user", text: input.text, at });
      emit({ type: "user-message", text: input.text });
    }
  };
  const answer = (): void => {
    if (reply) {
      transcript.push({ role: "assistant", text: reply });
      emit({ type: "text-start" });
      emit({ type: "text-delta", text: reply });
    }
    emit({ type: "turn-end", text: reply, ...(opts.error ? { error: opts.error } : {}) });
    if (opts.error) emit({ type: "error", message: opts.error });
  };
  const drain = (only?: Mode): void => {
    for (const input of queuedInputs.filter((q) => !only || q.mode === only)) {
      queuedInputs.splice(queuedInputs.indexOf(input), 1);
      enter(input);
      answer();
    }
  };
  const enqueue = (kind: keyof Queue, text: string): void => {
    queue[kind].push(text);
    emit({ type: "queue-state", ...structuredClone(queue) });
  };
  const turn = async (input: { text: string; origin?: SystemInputOrigin }): Promise<void> => {
    transition("streaming");
    // agent_start's turn-start, then the message's own, as agent/events.ts emits.
    emit({ type: "turn-start" });
    enter(input);
    if (opts.hold) {
      // Only an abort ends it: no answer, and Pi's queue goes with the run.
      await new Promise<void>((done) => { release = done; });
      emit({ type: "turn-end", text: "" });
      queuedInputs.length = 0;
      transition("idle");
      return;
    }
    await Promise.resolve();
    answer();
    drain();
    transition("idle");
  };

  const session: FakeSession = {
    id,
    calls: [],
    prompts: [],
    systemInputs: [],
    emit,
    get state() { return state; },
    setState(next) {
      if (next === "idle" && state === "streaming") drain();
      transition(next);
    },
    setQueue(next) { queue = { steering: [], followUp: [], ...next }; },
    deliverSteering() { drain("steer"); },
    get model() { return model; },
    get thinkingLevel() { return thinkingLevel; },
    contextUsage: opts.contextUsage,
    history: async () => [...transcript],
    async setModel(next) {
      if (!models.some((m) => m.provider === next.provider && m.id === next.id)) {
        throw new Error(`unknown model: ${next.provider}/${next.id}`);
      }
      model = next;
      session.calls.push(`setModel:${next.provider}/${next.id}`);
    },
    availableModels: async () => [...models],
    availableThinkingLevels: () => [...(opts.levels ?? [thinkingLevel])],
    setThinkingLevel(level) {
      thinkingLevel = level;
      session.calls.push(`setThinkingLevel:${level}`);
    },
    setCacheRetention: () => {},
    setCompactionCap: (tokens) => void session.calls.push(`compactionCap:${tokens}`),
    pendingQueue: async () => structuredClone(queue),
    // Like PiSession: anything still queued on an idle session was aborted.
    pendingSystemInputs: async () => (state === "idle" ? [] : queuedInputs.map((q) => q.origin)),
    async clearQueue() {
      session.calls.push("clearQueue");
      const drained = queue;
      queue = { steering: [], followUp: [] };
      queuedInputs.length = 0;
      emit({ type: "queue-state", ...queue });
      return drained;
    },
    rewindToUserTurn: async (index) => void session.calls.push(`rewind:${index}`),
    compact: async () => void session.calls.push("compact"),
    rename: async (name) => void session.calls.push(`rename:${name}`),
    async prompt(text) {
      session.calls.push(`prompt:${text}`);
      session.prompts.push(text);
      if (opts.scripted) return;
      // PiSession queues a prompt that finds a turn running as a follow-up.
      if (state === "streaming") enqueue("followUp", text);
      else await turn({ text });
    },
    async steer(text) {
      session.calls.push(`steer:${text}`);
      if (!opts.scripted) enqueue("steering", text);
    },
    async followUp(text) {
      session.calls.push(`followUp:${text}`);
      if (!opts.scripted) enqueue("followUp", text);
    },
    async systemInput(text, origin, mode) {
      session.calls.push(`systemInput:${origin.kind}:${mode}:${text}`);
      session.systemInputs.push({ text, origin, mode });
      if (opts.scripted) return;
      // Pi appends it to the context at once and starts nothing.
      if (mode === "append" && state === "idle") {
        transcript.push({ role: "system", text, origin, at: Date.now() });
        emit({ type: "system-input", text, origin, at: Date.now() });
        return;
      }
      if (state === "streaming") queuedInputs.push({ text, origin, mode });
      else await turn({ text, origin });
    },
    // Resolves once idle, like Pi's; the queue stays where it was.
    async abort() {
      session.calls.push("abort");
      if (release) {
        const held = release;
        release = undefined;
        held();
        await Promise.resolve();
      } else if (state === "streaming") {
        queuedInputs.length = 0;
        transition("idle");
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose: async () => void session.calls.push("dispose"),
  };
  return session;
}
