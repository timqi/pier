import type { AgentFactory, AgentSession } from "../core/types.js";
import { quietLabel, splitReply } from "../core/reply.js";
import { Router } from "../core/router.js";
import { TaskMessenger } from "./messages.js";
import { TaskStore } from "./store.js";
import type { AgentTaskAction, TaskResult, TaskRun } from "./types.js";

const MAX_ACTIVE_AGENTS = 4;
const MAX_ACTIVE_PER_ROOT = 4;

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
    await this.acquireSlot(run, signal);
    try {
      const session = await this.resolveSession(run, action);
      return await this.withSession(session.id, async () => {
        await this.waitUntilIdle(session, signal);
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
        run.context.renderedPrompt = prompt;
        this.store.saveRun(run);
        let text = "";
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn-end") text = event.text;
        });
        // The race below also settles this attempt if Pi ignores the abort:
        // a hung turn must not hold one of the 4 slots (and its waiters)
        // forever — the same guard execution.ts gives task-type children.
        let rejectAborted: (reason: Error) => void = () => {};
        const abortedTurn = new Promise<never>((_, reject) => { rejectAborted = reject; });
        abortedTurn.catch(() => {}); // handled via the race; never unhandled
        const abort = (): void => {
          void session.abort();
          rejectAborted(new Error("cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        // A pre-aborted signal never fires the listener: check before the
        // prompt starts or a cancelled run would hang until its timeout.
        if (signal.aborted) throw new Error("cancelled");
        try {
          const turn = session.systemInput(
            prompt,
            {
              kind: "task-delegation",
              taskId: run.taskId,
              runId: run.id,
              sourceSessionId: run.sourceSessionId,
            },
            "prompt",
          );
          await Promise.resolve();
          this.messages.deliverPendingControls(run);
          await Promise.race([turn, abortedTurn]);
          if (signal.aborted) throw new Error("cancelled");
          if (!text) {
            const history = await session.history();
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
          signal.removeEventListener("abort", abort);
          unsubscribe();
        }
      });
    } finally {
      this.releaseSlot(run.id);
    }
  }

  private async resolveSession(run: TaskRun, action: AgentTaskAction): Promise<AgentSession> {
    if (run.targetSessionId) {
      return this.router.ensure({ channelId: "task", conversationId: run.targetSessionId });
    }
    const listed = await this.factory.list();
    const source = run.sourceSessionId
      ? listed.find((session) => session.id === run.sourceSessionId)
      : undefined;
    const policy = action.session;
    let cwd: string;
    if (run.sessionMode === "fork") {
      if (!run.sourceSessionId) throw new Error("fork requires a source session");
      cwd = policy.mode === "fork" && policy.cwd ? policy.cwd : source?.cwd ?? "";
    } else if (policy.mode === "fresh") {
      cwd = policy.cwd;
    } else if (policy.mode === "reuse") {
      cwd = listed.find((session) => session.id === policy.sessionId)?.cwd ?? "";
    } else {
      cwd = policy.cwd ?? source?.cwd ?? "";
    }
    if (!cwd) throw new Error("could not resolve child working directory");
    const opts = {
      cwd,
      name: `${run.context.definition.name} [${run.id.slice(0, 8)}]`,
      // Unspecified model inherits the caller's live model, not the global
      // default; falls back to the default when the caller isn't attached.
      model: action.launch?.model ??
        (run.sourceSessionId ? this.router.modelOf(run.sourceSessionId) : undefined),
      thinking: action.launch?.thinking,
      capabilities: action.launch?.capabilities,
    };
    const session = run.sessionMode === "fork"
      ? await this.factory.fork(run.sourceSessionId!, opts)
      : await this.factory.create(opts);
    run.targetSessionId = session.id;
    run.context.sessionId = session.id;
    run.context.cwd = cwd;
    this.store.saveRun(run);
    this.router.attach({ channelId: "task", conversationId: session.id }, session);
    this.changed(run);
    return session;
  }

  private async acquireSlot(run: TaskRun, signal: AbortSignal): Promise<void> {
    while (this.active.size >= MAX_ACTIVE_AGENTS || this.activeForRoot(run.rootRunId) >= MAX_ACTIVE_PER_ROOT) {
      if (signal.aborted) throw new Error("cancelled");
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener("abort", abort);
          this.slotWaiters.delete(wake);
          resolve();
        };
        const abort = (): void => {
          this.slotWaiters.delete(wake);
          reject(new Error("cancelled"));
        };
        this.slotWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    this.active.add(run.id);
  }

  private activeForRoot(rootRunId: string): number {
    let count = 0;
    for (const id of this.active) {
      if (this.store.getRun(id)?.rootRunId === rootRunId) count += 1;
    }
    return count;
  }

  private releaseSlot(id: string): void {
    this.active.delete(id);
    for (const wake of this.slotWaiters) wake();
  }

  private async withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.sessionTails.set(sessionId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }

  private async waitUntilIdle(session: AgentSession, signal: AbortSignal): Promise<void> {
    // The session's own event stream is the only busy/idle signal — no polling.
    while (session.state === "streaming") {
      if (signal.aborted) throw new Error("cancelled");
      await new Promise<void>((resolve, reject) => {
        const settle = (error?: Error): void => {
          unsubscribe();
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = (): void => settle(new Error("cancelled"));
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "state" && event.state === "idle") settle();
        });
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
