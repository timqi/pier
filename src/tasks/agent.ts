import type { AgentFactory, AgentSession } from "../core/types.js";
import { Router } from "../core/router.js";
import { TaskMessenger } from "./messages.js";
import { TaskStore } from "./store.js";
import type { AgentTaskAction, TaskResult, TaskRun } from "./types.js";

const MAX_ACTIVE_AGENTS = 4;
const MAX_ACTIVE_PER_ROOT = 4;

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
        const input = JSON.stringify(run.input ?? null, null, 2);
        const prompt = run.context.resumePrompt ?? `${action.prompt}\n\n<task_input>\n${input}\n</task_input>`;
        run.context.sessionId = session.id;
        run.context.model = session.model;
        run.context.renderedPrompt = prompt;
        this.store.saveRun(run);
        let text = "";
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn-end") text = event.text;
        });
        const abort = (): void => void session.abort();
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
          await turn;
          if (signal.aborted) throw new Error("cancelled");
          if (!text) {
            const history = await session.history();
            text = [...history].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
          }
          return { type: "agent", text, sessionId: session.id };
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
