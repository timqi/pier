// What a parent and a child say to each other while a run is going. Every
// message is a durable row before it is a delivery: either end may be mid-turn
// or gone, and an undelivered message is retried, expired and said, never
// dropped (§5b).

import type { AgentSession, SystemInputOrigin } from "../core/types.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { runSource } from "./callbacks.js";
import { newId } from "./definitions.js";
import type { TaskStore } from "./store.js";
import type { TaskMessage, TaskMessageKind, TaskRun } from "./types.js";
import { isTerminal, MAX_DELIVERY_ATTEMPTS, retryDelay, undeliverable } from "./types.js";

const log = logger("tasks");

const MAX_MESSAGE_LENGTH = 16 * 1024;

function bounded(content: string): string {
  const text = content.trim();
  if (!text) throw new Error("message required");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_LENGTH) throw new Error("message exceeds 16 KiB");
  return text;
}

export class TaskMessenger {
  constructor(
    private readonly store: TaskStore,
    private readonly router: Router,
    private readonly hub: EventHub,
    /** Prepares a continuation; it starts only after the reply commits. */
    private readonly prepareResume: (runId: string, prompt: string, fromSessionId: string) => TaskRun,
    /** Reports a delivery nobody can complete (service.ts owns the surfaces). */
    private readonly unreachable: (sessionId: string, what: string, why: string) => void,
    private readonly startRun: (run: TaskRun) => void,
  ) {}

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
    if (run.targetSessionId) this.deliver(message, run, run.targetSessionId);
    return this.require(message.id);
  }

  deliverPendingControls(run: TaskRun): void {
    if (!run.targetSessionId) return;
    for (const message of this.store.listMessages(run.id)) {
      if (message.state !== "pending" || (message.kind !== "steer" && message.kind !== "follow_up")) continue;
      this.deliver(message, run, run.targetSessionId);
    }
  }

  /** Injection is fire-and-forget, so this sweep is what closes a failed one.
   * `inject` dedupes on the recipient transcript, so a retry cannot double
   * deliver. Controls aimed at a finished run are dead and expire here. */
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
        if (resumed?.startedAt) this.confirmed(message.id);
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
      if (target) this.deliver(message, run, target);
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
    this.deliver(message, run, run.invokedBySessionId);
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
    else if (run.targetSessionId) this.deliver(reply, run, run.targetSessionId);
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

  /** Never awaits the recipient: `systemInput` settles with the turn it
   *  triggers, which would block a child on its supervisor's whole turn.
   *  `delivered` is written by `confirmed`, against the one proof that survives
   *  an abort or a restart: the message in the recipient's transcript. */
  private deliver(candidate: TaskMessage, run: TaskRun, targetSessionId: string): void {
    const message = this.require(candidate.id);
    if (message.state !== "pending" && message.state !== "failed") return;
    if (message.toSessionId !== targetSessionId) message.toSessionId = targetSessionId;
    message.state = "pending";
    message.error = null;
    this.store.saveMessage(message);
    this.changed(message);
    void this.inject(message, run, targetSessionId, this.mode(message))
      .catch((error: unknown) => log.error(`message ${message.id} delivery collapsed`, error));
  }

  /** The one place a message becomes delivered. */
  private confirmed(id: string): void {
    const message = this.store.getMessage(id);
    if (!message || message.state !== "pending") return;
    message.state = "delivered";
    message.deliveredAt = Date.now();
    message.error = null;
    message.nextAttemptAt = null;
    this.store.saveMessage(message);
    this.changed(message);
  }

  /** Waiting is not a failed attempt; the ceiling is for deliveries that failed. */
  private defer(id: string): void {
    const message = this.store.getMessage(id);
    if (!message || message.state !== "pending") return;
    message.nextAttemptAt = Date.now() + 1000;
    this.store.saveMessage(message);
  }

  /** A recipient that never records the message must not be re-sent once a
   *  second forever. False: the ceiling was reached and the message expired. */
  private spend(id: string): boolean {
    const message = this.store.getMessage(id);
    if (!message || message.state !== "pending") return false;
    message.attempts += 1;
    message.nextAttemptAt = Date.now() + retryDelay(message.attempts);
    if (message.attempts > MAX_DELIVERY_ATTEMPTS) {
      this.abandon(message, undeliverable(message.attempts - 1, message.error));
      return false;
    }
    this.store.saveMessage(message);
    return true;
  }

  /** Both ends are told, and an expired decision stops suppressing its run's
   *  completion callback, which `execution.ts` decided once and never revisits. */
  private abandon(message: TaskMessage, why: string): void {
    message.state = "expired";
    message.error = why;
    message.answeredAt = Date.now();
    message.nextAttemptAt = null;
    this.store.saveMessage(message);
    this.changed(message);
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

  /** Steer whatever someone is blocked on: a follow-up lands only once the
   *  recipient runs out of tool calls. Progress is a follow-up because nobody waits. */
  private mode(message: TaskMessage): "steer" | "follow_up" {
    return message.kind === "follow_up" || message.kind === "progress" ? "follow_up" : "steer";
  }

  private failed(id: string, error: unknown, spent: boolean): void {
    const message = this.store.getMessage(id);
    // A late rejection must not undo a delivery a newer attempt proved.
    if (message?.state !== "pending") return;
    log.warn(`${message.kind} ${id} to session ${message.toSessionId} failed`, error);
    message.state = "failed";
    message.error = String(error);
    // An unresolvable target dies before the send every time, and would retry forever.
    if (!spent) message.attempts += 1;
    message.nextAttemptAt = Date.now() + retryDelay(message.attempts);
    this.store.saveMessage(message);
    this.changed(message);
    if (message.attempts > MAX_DELIVERY_ATTEMPTS) {
      this.abandon(message, undeliverable(message.attempts - 1, message.error));
    }
  }

  /** The dedupe on a retry and the proof of delivery are the same transcript
   *  read. Owns its own failure, so an attempt is counted exactly once. */
  private async inject(
    message: TaskMessage,
    run: TaskRun,
    targetSessionId: string,
    mode: "steer" | "follow_up",
  ): Promise<void> {
    let spent = false;
    try {
      const session = await this.router.ensure({ channelId: "task", conversationId: targetSessionId });
      const recorded = async (): Promise<boolean> =>
        (await session.history()).some((turn) =>
          turn.role === "system" && turn.origin?.kind === "task-message" && turn.origin.messageId === message.id);
      if (await recorded()) return this.confirmed(message.id);
      // Waiting in the recipient's queue: not recorded yet, and sending again
      // would deliver the same guidance twice. Costs no attempt.
      if (await this.queued(session, message.id)) return this.defer(message.id);
      spent = this.spend(message.id);
      if (!spent) return;
      await session.systemInput(
        this.format(message, run),
        this.origin(message, run),
        mode === "follow_up" ? "followUp" : mode,
      );
      if (await recorded()) this.confirmed(message.id);
    } catch (error) {
      this.failed(message.id, error, spent);
    }
  }

  /** The transcript answers "landed"; this answers "handed over and waiting". */
  private async queued(session: AgentSession, id: string): Promise<boolean> {
    return (await session.pendingSystemInputs()).some((origin) =>
      origin.kind === "task-message" && origin.messageId === id);
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
