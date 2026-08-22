import { randomUUID } from "node:crypto";
import type { SystemInputOrigin } from "../core/types.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { TaskStore } from "./store.js";
import type { TaskMessage, TaskMessageKind, TaskRun } from "./types.js";
import { isTerminal, retryDelay } from "./types.js";

const log = logger("tasks");

const MAX_MESSAGE_LENGTH = 16 * 1024;

function bounded(content: string): string {
  const text = content.trim();
  if (!text) throw new Error("message required");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_LENGTH) throw new Error("message exceeds 16 KiB");
  return text;
}

export class TaskMessenger {
  /** Retry schedule for failed injections. In-memory on purpose: a restart
   * expires undelivered control messages and re-offers decisions anyway. */
  private readonly retries = new Map<string, { attempts: number; nextAt: number }>();

  constructor(
    private readonly store: TaskStore,
    private readonly router: Router,
    private readonly hub: EventHub,
    /** Continues a terminal child with a supervisor reply as its prompt. */
    private readonly resumeRun: (runId: string, prompt: string, fromSessionId: string) => TaskRun,
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
  expireDecisions(runId: string, reason: string): void {
    for (const message of this.store.listMessages(runId)) {
      if (message.kind !== "decision" || (message.state !== "pending" && message.state !== "delivered")) continue;
      message.state = "expired";
      message.error = reason;
      message.answeredAt = Date.now();
      this.store.saveMessage(message);
      this.changed(message);
    }
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
    for (const message of this.store.listUndeliveredMessages()) {
      const run = this.store.getRun(message.runId);
      if (!run) continue;
      // Expiring a dead control is not a retry, so it ignores the backoff.
      if ((message.kind === "steer" || message.kind === "follow_up") && isTerminal(run.state)) {
        message.state = "expired";
        message.error = "run finished before delivery completed";
        this.store.saveMessage(message);
        this.changed(message);
        continue;
      }
      if ((this.retries.get(message.id)?.nextAt ?? 0) > now) continue;
      const target = message.toSessionId || run.targetSessionId;
      if (target) this.deliver(message, run, target);
    }
  }

  /** Asynchronous by design: returns the receipt immediately. A decision
   * child states what it awaits and ends its turn; the reply arrives as a
   * follow-up (active run) or resumes the session (terminal run).
   * A decision steers the supervisor: a follow-up only lands once the
   * supervisor has no tool calls left, so a blocked child would wait out the
   * whole turn. Progress stays a follow-up — nobody waits on it. */
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
    const reply = this.create(run, "reply", fromSessionId, question.fromSessionId, text, question.id);
    question.state = "answered";
    question.answeredAt = Date.now();
    this.store.saveMessage(question);
    this.changed(question);
    // Core routes the reply: follow-up into an active run, auto-resume of a
    // terminal one — the replier gets the continuation's callback.
    if (run.targetSessionId && (run.state === "queued" || run.state === "running")) {
      this.deliver(reply, run, run.targetSessionId);
    } else if (isTerminal(run.state)) {
      this.resumeRun(run.id, this.format(reply, run), fromSessionId);
      reply.state = "delivered";
      reply.deliveredAt = Date.now();
      this.store.saveMessage(reply);
      this.changed(reply);
    }
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
      id: randomUUID(),
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
    };
    this.store.saveMessage(message);
    this.changed(message);
    return message;
  }

  /** Never awaits the recipient: the seam's `systemInput` settles with the turn
   * the input triggers, so awaiting it would block the sender — a child's
   * `contact` on its supervisor's whole answer turn — which the design forbids.
   * Delivery is therefore recorded on hand-off and corrected to `failed` by the
   * catch; the tick sweep retries from there. */
  private deliver(candidate: TaskMessage, run: TaskRun, targetSessionId: string): void {
    const message = this.require(candidate.id);
    if (message.state !== "pending" && message.state !== "failed") return;
    if (message.toSessionId !== targetSessionId) message.toSessionId = targetSessionId;
    message.state = "delivered";
    message.deliveredAt = Date.now();
    message.error = null;
    this.retries.delete(message.id); // a redelivery starts its backoff fresh
    this.store.saveMessage(message);
    this.changed(message);
    void this.inject(message, run, targetSessionId, this.mode(message))
      .catch((error: unknown) => { this.failed(message.id, error); });
  }

  /** A decision steers — a follow-up would land only after the supervisor runs
   * out of tool calls, leaving the child waiting out the whole turn. */
  private mode(message: TaskMessage): "steer" | "follow_up" {
    return message.kind === "steer" || message.kind === "decision" ? "steer" : "follow_up";
  }

  private failed(id: string, error: unknown): void {
    const message = this.store.getMessage(id);
    if (!message || message.state === "answered" || message.state === "expired") return;
    // Both ends are waiting on this one: the sender for an answer, the
    // recipient for a message it never got told about.
    log.warn(`${message.kind} ${id} to session ${message.toSessionId} failed`, error);
    message.state = "failed";
    message.error = String(error);
    this.store.saveMessage(message);
    this.changed(message);
    const attempts = (this.retries.get(id)?.attempts ?? 0) + 1;
    this.retries.set(id, { attempts, nextAt: Date.now() + retryDelay(attempts) });
  }

  private async inject(
    message: TaskMessage,
    run: TaskRun,
    targetSessionId: string,
    mode: "steer" | "follow_up",
  ): Promise<void> {
    const session = await this.router.ensure({ channelId: "task", conversationId: targetSessionId });
    const delivered = (await session.history()).some((turn) =>
      turn.role === "system" && turn.origin?.kind === "task-message" && turn.origin.messageId === message.id);
    if (delivered) return;
    await session.systemInput(
      this.format(message, run),
      this.origin(message, run),
      mode === "follow_up" ? "followUp" : mode,
    );
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
    };
  }

  private require(id: string): TaskMessage {
    const message = this.store.getMessage(id);
    if (!message) throw new Error(`unknown task message: ${id}`);
    return message;
  }

  private changed(message: TaskMessage): void {
    this.hub.emitWorkspace({ type: "task-message-changed", runId: message.runId, messageId: message.id });
  }
}
