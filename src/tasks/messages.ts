import { randomUUID } from "node:crypto";
import type { SystemInputOrigin } from "../core/types.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { TaskStore } from "./store.js";
import type { TaskMessage, TaskMessageKind, TaskRun } from "./types.js";

const MAX_MESSAGE_LENGTH = 16 * 1024;

type ReplyWaiter = {
  resolve: (message: TaskMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function bounded(content: string): string {
  const text = content.trim();
  if (!text) throw new Error("message required");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_LENGTH) throw new Error("message exceeds 16 KiB");
  return text;
}

export class TaskMessenger {
  private readonly replyWaiters = new Map<string, ReplyWaiter>();

  constructor(
    private readonly store: TaskStore,
    private readonly router: Router,
    private readonly hub: EventHub,
  ) {}

  expirePending(): void {
    for (const message of this.store.expirePendingMessages()) this.changed(message);
    for (const [id, waiter] of this.replyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pier stopped before the supervisor replied"));
      this.replyWaiters.delete(id);
    }
  }

  list(runId: string): TaskMessage[] {
    return this.store.listMessages(runId);
  }

  recent(since: number, limit = 200): TaskMessage[] {
    return this.store.listRecentMessages(since, limit);
  }

  async control(
    run: TaskRun,
    fromSessionId: string,
    kind: "steer" | "follow_up",
    content: string,
    retryOf: string | null = null,
  ): Promise<TaskMessage> {
    const message = this.create(run, kind, fromSessionId, run.targetSessionId ?? "", content, null, retryOf);
    if (run.targetSessionId) await this.deliver(message, run, run.targetSessionId, kind);
    return this.require(message.id);
  }

  async deliverPendingControls(run: TaskRun): Promise<void> {
    if (!run.targetSessionId) return;
    for (const message of this.store.listMessages(run.id)) {
      if (message.state !== "pending" || (message.kind !== "steer" && message.kind !== "follow_up")) continue;
      try {
        await this.deliver(message, run, run.targetSessionId, message.kind);
      } catch (error) {
        console.warn(`Task control message ${message.id} delivery failed`, error);
      }
    }
  }

  async contact(
    run: TaskRun,
    fromSessionId: string,
    reason: "progress" | "decision",
    content: string,
    wait: boolean,
    signal?: AbortSignal,
  ): Promise<{ message: TaskMessage; reply?: TaskMessage }> {
    if (!run.invokedBySessionId) throw new Error("run has no supervisor session");
    if (!run.background) throw new Error("supervisor contact requires a detached run");
    if (reason === "decision" && this.store.listMessages(run.id).some((m) =>
      m.kind === "decision" && (m.state === "pending" || m.state === "delivered"))) {
      throw new Error("run already has a pending supervisor decision");
    }
    const message = this.create(
      run,
      reason,
      fromSessionId,
      run.invokedBySessionId,
      content,
      null,
      null,
    );
    const replyPromise = reason === "decision" && wait
      ? this.waitForReply(message, run, signal)
      : undefined;
    try {
      await this.deliver(message, run, run.invokedBySessionId, "follow_up");
    } catch (error) {
      this.rejectWaiter(message.id, error);
      throw error;
    }
    return replyPromise ? { message: this.require(message.id), reply: await replyPromise } : { message: this.require(message.id) };
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
    const reply = this.create(run, "reply", fromSessionId, question.fromSessionId, text, question.id, null);
    reply.state = "delivered";
    reply.deliveredAt = Date.now();
    this.store.saveMessage(reply);
    question.state = "answered";
    question.answeredAt = Date.now();
    this.store.saveMessage(question);
    this.changed(reply);
    this.changed(question);
    const waiter = this.replyWaiters.get(question.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.replyWaiters.delete(question.id);
      waiter.resolve(reply);
    } else if (run.targetSessionId && (run.state === "queued" || run.state === "running")) {
      await this.inject(reply, run, run.targetSessionId, "follow_up");
    }
    return reply;
  }

  private create(
    run: TaskRun,
    kind: TaskMessageKind,
    fromSessionId: string,
    toSessionId: string,
    content: string,
    replyTo: string | null,
    retryOf: string | null,
  ): TaskMessage {
    const message: TaskMessage = {
      id: randomUUID(),
      runId: run.id,
      kind,
      fromSessionId,
      toSessionId,
      replyTo,
      retryOf,
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

  private async deliver(
    candidate: TaskMessage,
    run: TaskRun,
    targetSessionId: string,
    mode: "steer" | "follow_up",
  ): Promise<void> {
    const message = this.require(candidate.id);
    if (message.state !== "pending") return;
    if (message.toSessionId !== targetSessionId) {
      message.toSessionId = targetSessionId;
      this.store.saveMessage(message);
    }
    try {
      await this.inject(message, run, targetSessionId, mode);
      const current = this.require(message.id);
      if (current.state !== "answered") {
        current.state = "delivered";
        current.deliveredAt = Date.now();
        current.error = null;
        this.store.saveMessage(current);
        this.changed(current);
      }
    } catch (error) {
      const current = this.require(message.id);
      if (current.state !== "answered") {
        current.state = "failed";
        current.error = String(error);
        this.store.saveMessage(current);
        this.changed(current);
      }
      throw error;
    }
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

  private waitForReply(message: TaskMessage, run: TaskRun, signal?: AbortSignal): Promise<TaskMessage> {
    const elapsed = Date.now() - run.queuedAt;
    const timeoutMs = Math.max(1, run.context.definition.timeoutSeconds * 1000 - elapsed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replyWaiters.delete(message.id);
        const current = this.require(message.id);
        if (current.state !== "answered") {
          current.state = "expired";
          current.error = "supervisor reply timed out";
          current.answeredAt = Date.now();
          this.store.saveMessage(current);
          this.changed(current);
        }
        reject(new Error("supervisor reply timed out"));
      }, timeoutMs);
      timer.unref();
      this.replyWaiters.set(message.id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => this.rejectWaiter(message.id, new Error("contact cancelled")), { once: true });
    });
  }

  private rejectWaiter(id: string, error: unknown): void {
    const waiter = this.replyWaiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.replyWaiters.delete(id);
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
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
