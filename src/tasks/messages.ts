// What a parent and a child say to each other while a run is going. Every
// message is a durable row before it is a delivery: either end may be mid-turn
// or gone, and an undelivered message is retried, expired and said, never
// dropped (§5). Delivery itself belongs to outbox.ts.

import type { SystemInputOrigin } from "../core/types.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import { runSource } from "./callbacks.js";
import { newId } from "./definitions.js";
import { Outbox } from "./outbox.js";
import type { TaskStore } from "./store.js";
import type { CallbackFields, TaskMessage, TaskMessageKind, TaskMessageState, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

const MAX_MESSAGE_LENGTH = 16 * 1024;

/** A message under the engine's column names; `save` writes them back. */
interface Carried extends CallbackFields {
  message: TaskMessage;
}

/** `answered` is a delivery that was read; `expired` is one given up on. */
const ENGINE_STATE: Record<TaskMessageState, CallbackFields["callbackState"]> = {
  pending: "pending", failed: "failed", delivered: "delivered", answered: "delivered", expired: "abandoned",
};

function bounded(content: string): string {
  const text = content.trim();
  if (!text) throw new Error("message required");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_LENGTH) throw new Error("message exceeds 16 KiB");
  return text;
}

export class TaskMessenger {
  private readonly outbox: Outbox<Carried>;

  constructor(
    private readonly store: TaskStore,
    router: Router,
    private readonly hub: EventHub,
    /** Prepares a continuation; it starts only after the reply commits. */
    private readonly prepareResume: (runId: string, prompt: string, fromSessionId: string) => TaskRun,
    /** Reports a delivery nobody can complete (service.ts owns the surfaces). */
    private readonly unreachable: (sessionId: string, what: string, why: string) => void,
    private readonly startRun: (run: TaskRun) => void,
  ) {
    this.outbox = new Outbox<Carried>(router, {
      id: ({ message }) => message.id,
      reload: (id) => {
        const message = this.store.getMessage(id);
        return message && this.carry(message);
      },
      save: ({ message, callbackState, callbackAttempts, callbackError, callbackNextAttemptAt }) => {
        message.attempts = callbackAttempts;
        message.error = callbackError;
        message.nextAttemptAt = callbackNextAttemptAt;
        if (callbackState === "delivered") {
          message.state = "delivered";
          message.deliveredAt = Date.now();
        } else if (callbackState === "abandoned") {
          message.state = "expired";
          message.answeredAt = Date.now();
        } else message.state = callbackState ?? "pending";
        this.store.saveMessage(message);
      },
      changed: ({ message }) => this.changed(message),
      input: (records) => {
        const message = records[0]!.message;
        const run = this.store.getRun(message.runId);
        if (!run) throw new Error(`unknown task run: ${message.runId}`);
        return { text: this.format(message, run), origin: this.origin(message, run) };
      },
      abandoned: ({ message }, _sessionId, why) => this.told(message, why),
      // A follow-up joins the recipient's queue now: the run it guides may end
      // with the turn it would otherwise wait out.
      queues: true,
    });
  }

  expirePending(): void {
    for (const message of this.store.expirePendingMessages()) this.changed(message);
  }

  /** The unanswered decision on a run, if any. */
  openDecisionId(runId: string): string | null {
    return this.store.listMessages(runId).find((m) =>
      m.kind === "decision" && (m.state === "pending" || m.state === "delivered"))?.id ?? null;
  }

  /** A manual continuation supersedes an unanswered decision (design 04):
   * one continuation per run, never two racing ones. */
  expireDecisions(runId: string, reason: string): TaskMessage[] {
    const expired: TaskMessage[] = [];
    for (const message of this.store.listMessages(runId)) {
      if (message.kind !== "decision" || (message.state !== "pending" && message.state !== "delivered")) continue;
      message.state = "expired";
      message.error = reason;
      message.answeredAt = Date.now();
      this.store.saveMessage(message);
      expired.push(message);
    }
    return expired;
  }

  list(runId: string): TaskMessage[] {
    return this.store.listMessages(runId);
  }

  recent(since: number): TaskMessage[] {
    return this.store.listRecentMessages(since);
  }

  async control(
    run: TaskRun,
    fromSessionId: string,
    kind: "steer" | "follow_up",
    content: string,
  ): Promise<TaskMessage> {
    const message = this.create(run, kind, fromSessionId, run.targetSessionId ?? "", content, null);
    this.changed(message);
    if (run.targetSessionId) this.deliver(message, run.targetSessionId);
    return this.require(message.id);
  }

  deliverPendingControls(run: TaskRun): void {
    if (!run.targetSessionId) return;
    for (const message of this.store.listMessages(run.id)) {
      if (message.state !== "pending" || (message.kind !== "steer" && message.kind !== "follow_up")) continue;
      this.deliver(message, run.targetSessionId);
    }
  }

  /** Delivery is fire-and-forget, so this sweep is what closes a failed one.
   * Controls aimed at a finished run are dead and expire here. */
  retryUndelivered(now = Date.now()): void {
    for (const { message, run } of this.store.listUndeliveredMessages()) {
      if (!run) continue;
      // Expiring a dead control is not a retry, so it ignores the backoff.
      if ((message.kind === "steer" || message.kind === "follow_up") && isTerminal(run.state)) {
        message.state = "expired";
        message.error = "run finished before delivery completed";
        this.store.saveMessage(message);
        this.changed(message);
        continue;
      }
      // A reply that resumed a terminal run is the continuation's prompt, not a
      // system input: the transcript read would re-inject it and start a turn no
      // run owns. The continuation's `startedAt` is the proof instead.
      if (message.kind === "reply" && isTerminal(run.state)) {
        const resumed = message.resumeRunId ? this.store.getRun(message.resumeRunId) : undefined;
        if (resumed?.startedAt) this.delivered(message);
        else if (!resumed) this.abandon(message, `continuation ${message.resumeRunId ?? "(none)"} is gone`);
        else if (isTerminal(resumed.state)) {
          // Never started and never will: said now, not four minutes later at
          // the ceiling. A duplicate report beats a special case that could
          // suppress the only one.
          this.abandon(message, `continuation ${resumed.id} ${resumed.state} before it started`);
        }
        continue;
      }
      if ((message.nextAttemptAt ?? 0) > now) continue;
      const target = message.toSessionId || run.targetSessionId;
      if (target) this.deliver(message, target);
    }
  }

  /** Returns the receipt immediately; the reply arrives as a follow-up (active
   *  run) or resumes the session (terminal run). A decision steers the
   *  supervisor, or a blocked child would wait out its whole turn. */
  async contact(
    run: TaskRun,
    fromSessionId: string,
    reason: "progress" | "decision",
    content: string,
  ): Promise<TaskMessage> {
    if (!run.invokedBySessionId) throw new Error("run has no supervisor session");
    if (reason === "decision" && this.openDecisionId(run.id)) {
      throw new Error("run already has a pending supervisor decision");
    }
    const message = this.create(run, reason, fromSessionId, run.invokedBySessionId, content, null);
    this.changed(message);
    this.deliver(message, run.invokedBySessionId);
    return this.require(message.id);
  }

  async reply(questionId: string, fromSessionId: string, content: string): Promise<TaskMessage> {
    const question = this.require(questionId);
    if (question.kind !== "decision") throw new Error("message is not a decision request");
    if (question.toSessionId !== fromSessionId) throw new Error("only the addressed supervisor may reply");
    const existing = this.store.listMessages(question.runId).find((m) => m.kind === "reply" && m.replyTo === question.id);
    const text = bounded(content);
    if (existing) {
      if (existing.content !== text) throw new Error("decision already answered with different content");
      return existing;
    }
    if (question.state !== "delivered" && question.state !== "pending") {
      throw new Error(`decision is ${question.state}`);
    }
    const run = this.store.getRun(question.runId);
    if (!run) throw new Error(`unknown task run: ${question.runId}`);
    // A rejected continuation must leave the question answerable. Persist the
    // answer and its queued run together, before either publishes or executes.
    const { reply, continuation } = this.store.transact(() => {
      const reply = this.create(run, "reply", fromSessionId, question.fromSessionId, text, question.id);
      question.state = "answered";
      question.answeredAt = Date.now();
      this.store.saveMessage(question);
      const continuation = isTerminal(run.state)
        ? this.prepareResume(run.id, this.format(reply, run), fromSessionId)
        : undefined;
      if (continuation) {
        reply.resumeRunId = continuation.id;
        this.store.saveMessage(reply);
      }
      return { reply, continuation };
    });
    this.changed(question);
    this.changed(reply);
    if (continuation) this.startRun(continuation);
    else if (run.targetSessionId) this.deliver(reply, run.targetSessionId);
    return this.require(reply.id);
  }

  private create(
    run: TaskRun,
    kind: TaskMessageKind,
    fromSessionId: string,
    toSessionId: string,
    content: string,
    replyTo: string | null,
  ): TaskMessage {
    const message: TaskMessage = {
      id: newId(),
      runId: run.id,
      kind,
      fromSessionId,
      toSessionId,
      replyTo,
      state: "pending",
      content: bounded(content),
      createdAt: Date.now(),
      deliveredAt: null,
      answeredAt: null,
      error: null,
      attempts: 0,
      nextAttemptAt: null,
    };
    this.store.saveMessage(message);
    return message;
  }

  /** A control created before its run had a session is aimed once it has one. */
  private deliver(message: TaskMessage, targetSessionId: string): void {
    if (message.toSessionId !== targetSessionId) {
      message.toSessionId = targetSessionId;
      this.store.saveMessage(message);
    }
    void this.outbox.deliver(targetSessionId, [this.carry(message)]);
  }

  private carry(message: TaskMessage): Carried {
    return {
      message,
      callbackState: ENGINE_STATE[message.state],
      callbackAttempts: message.attempts,
      callbackError: message.error,
      callbackNextAttemptAt: message.nextAttemptAt,
      // Steer whatever someone is blocked on: a follow-up lands only once the
      // recipient runs out of tool calls. Progress is a follow-up because nobody waits.
      ...(message.kind === "follow_up" || message.kind === "progress" ? {} : { callbackMode: "steer" as const }),
    };
  }

  /** Proven by something other than the recipient's transcript. */
  private delivered(message: TaskMessage): void {
    message.state = "delivered";
    message.deliveredAt = Date.now();
    message.error = null;
    message.nextAttemptAt = null;
    this.store.saveMessage(message);
    this.changed(message);
  }

  private abandon(message: TaskMessage, why: string): void {
    message.state = "expired";
    message.error = why;
    message.answeredAt = Date.now();
    message.nextAttemptAt = null;
    this.store.saveMessage(message);
    this.changed(message);
    this.told(message, why);
  }

  /** Both ends are told, and an expired decision stops suppressing its run's
   *  completion callback, which `execution.ts` decided once and never revisits. */
  private told(message: TaskMessage, why: string): void {
    this.unreachable(message.toSessionId, `a ${message.kind} from run ${message.runId}`, why);
    if (message.fromSessionId && message.fromSessionId !== message.toSessionId) {
      this.unreachable(message.fromSessionId, `your ${message.kind} on run ${message.runId}`, why);
    }
    const run = this.store.getRun(message.runId);
    if (message.kind !== "decision" || !run?.callbackSessionId) return;
    if (run.callbackState === null && isTerminal(run.state)) {
      run.callbackState = "pending"; // the tick sweep delivers it
      this.store.saveRun(run);
    }
  }

  private format(message: TaskMessage, run: TaskRun): string {
    const title = run.context.definition.name;
    if (message.kind === "progress") {
      return `Subagent progress for task "${title}"\nRun: ${run.id}\nMessage: ${message.id}\n\n${message.content}`;
    }
    if (message.kind === "decision") {
      return `Subagent needs a decision for task "${title}"\nRun: ${run.id}\nMessage: ${message.id}\nReply with the Task reply operation.\n\n${message.content}`;
    }
    if (message.kind === "reply") {
      return `Supervisor reply for task "${title}"\nRun: ${run.id}\nReply to: ${message.replyTo ?? "-"}\n\n${message.content}`;
    }
    return `Task guidance for "${title}"\nRun: ${run.id}\nMessage: ${message.id}\n\n${message.content}`;
  }

  private origin(message: TaskMessage, run: TaskRun): SystemInputOrigin {
    return {
      kind: "task-message",
      taskId: run.taskId,
      runId: run.id,
      sourceSessionId: message.fromSessionId,
      messageId: message.id,
      messageKind: message.kind,
      source: runSource(run),
    };
  }

  private require(id: string): TaskMessage {
    const message = this.store.getMessage(id);
    if (!message) throw new Error(`unknown task message: ${id}`);
    return message;
  }

  /** Publish only after any transaction changing this message has committed. */
  changed(message: TaskMessage): void {
    this.hub.emitWorkspace({ type: "task-message-changed", runId: message.runId, messageId: message.id });
  }
}
