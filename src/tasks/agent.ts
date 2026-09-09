// A run that *is* a Pi session: which session it opens (fresh or reused),
// what the child is told before the prompt, and how many may run at once. The
// concurrency caps are here rather than in execution.ts because they bound
// agents specifically — a bash run costs a process, an agent run costs a
// model's context and someone's rate limit.

import type { AgentFactory, AgentSession } from "../core/types.js";
import { quietLabel, splitReply } from "../core/reply.js";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { runSource } from "./callbacks.js";
import type { TaskMessenger } from "./messages.js";
import type { TaskStore } from "./store.js";
import type { AgentTaskAction, TaskResult, TaskRun } from "./types.js";

const MAX_ACTIVE_AGENTS = 4;
const log = logger("tasks");

/** What a child cannot know unless told. Every session gets the chat-surface
 * contract (<pier>/AGENTS.md), task runs included — so the delegation prompt
 * says which of it does not apply here, and a supervised run how to reach the
 * agent that is waiting on it. Skipped on resume: the session already saw it. */
const preamble = (run: TaskRun): string => {
  // A cron/watch task with a session callback is read by an agent too.
  const audience = run.invokedBySessionId
    ? "read by the agent that delegated this run"
    : run.callbackSessionId
      ? "read by the agent session it is delivered to"
      : "read by the operator";
  const contact = run.invokedBySessionId
    ? ' Mid-run, the task tool\'s contact operation reaches that agent: reason "progress" is fire-and-forget, "decision" waits for a reply — state what you await and end your turn.'
    : "";
  return `[Pier task run ${run.id} — "${run.context.definition.name}"] ` +
    `Your final reply is recorded verbatim as the run result, ${audience}; ` +
    `next-step buttons and file:// attachments do not render there.${contact}\n\n`;
};

export class AgentTaskRunner {
  private readonly active = new Set<string>();
  private readonly slotWaiters = new Set<() => void>();
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly factory: AgentFactory,
    private readonly router: Router,
    private readonly store: TaskStore,
    private readonly messages: TaskMessenger,
    private readonly changed: (run: TaskRun) => void,
  ) {}

  async execute(
    run: TaskRun,
    action: AgentTaskAction,
    signal: AbortSignal,
    start: () => void,
  ): Promise<TaskResult> {
    // Reserve reuse order before resolving the session: a slow resume must not
    // let a later run pass it. Fresh runs each have their own queue key.
    return this.withSession(run.targetSessionId ?? run.id, signal, async () => {
      const reused = run.targetSessionId ? await this.resolveSession(run, action, signal) : undefined;
      if (reused) await this.waitUntilIdle(reused, signal);
      await this.acquireSlot(run, signal);
      try {
        const session = reused ?? await this.resolveSession(run, action, signal);
        // A reused session may have become busy while we waited for a slot.
        await this.waitUntilIdle(session, signal);
        signal.throwIfAborted();
        // Task requests come seconds apart — the 1h Anthropic cache-write premium
        // never earns its 2× back, so task runs use the 5m TTL. Set here, not in
        // resolveSession: this covers create, reuse and resume alike, on
        // every attempt — and only after the session is idle, so a reused
        // interactive session's in-flight turn keeps its 1h writes.
        session.setCacheRetention("short");
        start();
        // No input is no block: `<task_input>\nnull\n</task_input>` is four
        // lines telling the agent nothing, on every run that has no input.
        // Compact for the same reason tool results are (agent/pi.ts), and
        // `<\/` is the same JSON — a value cannot close the fence early.
        const input = run.input === undefined || run.input === null
          ? ""
          : `\n\n<task_input>\n${JSON.stringify(run.input).replaceAll("</task_input>", "<\\/task_input>")}\n</task_input>`;
        const prompt = run.context.resumePrompt ?? `${preamble(run)}${action.prompt}${input}`;
        run.context.sessionId = session.id;
        run.context.model = session.model;
        // The level the session settled on, not the one the task asked for:
        // an unspecified effort inherits the caller's, and the card in the
        // subagent's own transcript should say which one that was.
        run.context.thinking = session.thinkingLevel;
        run.context.renderedPrompt = prompt;
        this.store.saveRun(run);
        let text = "";
        // Not only what the turn said but how it ended: a provider outage ends
        // it with an empty reply, and a run that settles on that reports "no
        // reply" — the one wording for a turn that *chose* to say nothing, so
        // the outage arrives at the caller looking like an answer (§5b). Pi has
        // already retried by the time this lands; the run only reports.
        let failure: string | undefined;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn-end") {
            text = event.text;
            failure = event.error;
          }
        });
        // Cancel the SDK turn, but release our wait even if its abort hangs.
        const abort = (): void => {
          void Promise.resolve().then(() => session.abort())
            .catch((error: unknown) => log.warn(`run ${run.id} session abort failed`, error));
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          // Pre-abort does not fire a newly registered listener; keep the check
          // inside finally's scope so it also restores retention/subscriptions.
          signal.throwIfAborted();
          const turn = session.systemInput(
            prompt,
            {
              kind: "task-delegation",
              taskId: run.taskId,
              runId: run.id,
              sourceSessionId: run.sourceSessionId,
              source: runSource(run),
            },
            "prompt",
          );
          await Promise.resolve();
          this.messages.deliverPendingControls(run);
          await this.untilAborted(turn, signal);
          if (signal.aborted) throw new Error("cancelled");
          // Before the fallback below: on a reused session that reads the
          // *previous* turn's answer back out of history and reports it as
          // this run's result.
          if (failure) throw new Error(failure);
          if (!text) {
            const history = await this.untilAborted(session.history(), signal);
            text = [...history].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
          }
          // The chat contract is injected into task sessions too, so a child's
          // reply may carry chat-only markup. The result is read by a
          // supervisor or the Console, never a chat renderer: buttons are
          // dropped, and a turn that said nothing names which kind of nothing
          // it was (principle 5b) instead of storing an empty result.
          const reply = splitReply(text);
          return { type: "agent", text: reply.text || quietLabel(reply.silence), sessionId: session.id };
        } finally {
          // The run is what earns "short"; a reused interactive session goes
          // back to chat afterwards. For task-created sessions this is moot —
          // idle until the next run downgrades them again.
          session.setCacheRetention("long");
          signal.removeEventListener("abort", abort);
          unsubscribe();
        }
      } finally {
        this.releaseSlot(run.id);
      }
    });
  }

  private async resolveSession(run: TaskRun, action: AgentTaskAction, signal: AbortSignal): Promise<AgentSession> {
    signal.throwIfAborted();
    if (run.targetSessionId) {
      return this.untilAborted(this.router.ensure({ channelId: "task", conversationId: run.targetSessionId }), signal);
    }
    const policy = action.session;
    // Definitions stored before fork was removed still say `"fork"`. Refused by
    // name: every directory this could pick instead is a guess at what the
    // author meant, and a child in the wrong tree edits real files.
    if (run.sessionMode === "fork" || (policy as { mode: string }).mode === "fork") {
      throw new Error(
        `task "${run.context.definition.name}" uses the removed fork session mode; recreate it with {"mode":"fresh","cwd":"/abs/path"}`,
      );
    }
    const cwd = policy.mode === "fresh"
      ? policy.cwd
      : (await this.untilAborted(this.factory.find(policy.sessionId), signal))?.cwd ?? "";
    signal.throwIfAborted();
    if (!cwd) throw new Error("could not resolve child working directory");
    const opts = {
      cwd,
      name: `${run.context.definition.name} [${run.id.slice(0, 8)}]`,
      // Unspecified model inherits the caller's live model, not the global
      // default; falls back to the default when the caller isn't attached.
      model: action.launch?.model ??
        (run.sourceSessionId ? this.router.modelOf(run.sourceSessionId) : undefined),
      thinking: action.launch?.thinking,
    };
    const opening = this.factory.create(opts).then(async (session) => {
      // SDK creation cannot be cancelled. A late session still belongs to
      // this run; read back its terminal row so delivery updates are preserved.
      // Remember it on the live run too: cancellation's final save can race
      // this callback before it finishes writing the terminal record.
      run.targetSessionId = session.id;
      run.context.sessionId = session.id;
      run.context.cwd = cwd;
      const owner = signal.aborted ? this.store.getRun(run.id) ?? run : run;
      owner.targetSessionId = run.targetSessionId;
      owner.context = run.context;
      try {
        this.store.saveRun(owner);
        this.changed(owner);
      } finally {
        if (signal.aborted) await session.dispose();
        else this.router.attach({ channelId: "task", conversationId: session.id }, session);
      }
      return session;
    });
    // A late rejection cannot reach execute's already-cancelled race.
    void opening.catch((error: unknown) => {
      if (signal.aborted) log.warn(`session creation for cancelled run ${run.id} failed`, error);
    });
    const session = await this.untilAborted(opening, signal);
    signal.throwIfAborted();
    return session;
  }

  private async acquireSlot(run: TaskRun, signal: AbortSignal): Promise<void> {
    while (this.active.size >= MAX_ACTIVE_AGENTS) {
      let wake = (): void => {};
      try {
        await this.untilAborted(new Promise<void>((resolve) => {
          wake = resolve;
          this.slotWaiters.add(wake);
        }), signal);
      } finally {
        this.slotWaiters.delete(wake);
      }
    }
    signal.throwIfAborted();
    this.active.add(run.id);
  }

  private releaseSlot(id: string): void {
    this.active.delete(id);
    for (const wake of this.slotWaiters) wake();
  }

  private async untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort = (): void => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async withSession<T>(sessionId: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.sessionTails.set(sessionId, tail);
    // Even if this waiter is cancelled, its tail still includes its predecessor.
    // Only delete after that tail drains, or a new arrival could skip the queue.
    void tail.then(() => {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    });
    try {
      await this.untilAborted(previous, signal);
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }

  private async waitUntilIdle(session: AgentSession, signal: AbortSignal): Promise<void> {
    // The session's own event stream is the only busy/idle signal — no polling.
    while (session.state === "streaming") {
      let unsubscribe = (): void => {};
      try {
        await this.untilAborted(new Promise<void>((resolve) => {
          unsubscribe = session.subscribe((event) => {
            if (event.type === "state" && event.state === "idle") resolve();
          });
        }), signal);
      } finally {
        unsubscribe();
      }
    }
  }
}
