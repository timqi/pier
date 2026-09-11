// What a parent says to a child while a run is going. Every message is a
// durable row before it is a delivery: the child may be mid-turn or gone, and
// an undelivered message is retried, expired and said, never dropped (§5).
// Delivery itself belongs to outbox.ts.

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

/** `expired` is a delivery given up on. */
const ENGINE_STATE: Record<TaskMessageState, CallbackFields["callbackState"]> = {
  pending: "pending", failed: "failed", delivered: "delivered", expired: "abandoned",
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
    /** Reports a delivery nobody can complete (service.ts owns the surfaces). */
    private readonly unreachable: (sessionId: string, what: string, why: string) => void,
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
        } else if (callbackState === "abandoned") message.state = "expired";
        else message.state = callbackState ?? "pending";
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

  list(runId: string): TaskMessage[] {
    return this.store.listMessages(runId);
  }

  recent(since: number): TaskMessage[] {
    return this.store.listRecentMessages(since);
  }

  async control(
    run: TaskRun,
    fromSessionId: string,
    kind: TaskMessageKind,
    content: string,
  ): Promise<TaskMessage> {
    const message = this.create(run, kind, fromSessionId, run.targetSessionId ?? "", content);
    this.changed(message);
    if (run.targetSessionId) this.deliver(message, run.targetSessionId);
    return this.require(message.id);
  }

  deliverPendingControls(run: TaskRun): void {
    if (!run.targetSessionId) return;
    for (const message of this.store.listMessages(run.id)) {
      if (message.state === "pending") this.deliver(message, run.targetSessionId);
    }
  }

  /** Delivery is fire-and-forget, so this sweep is what closes a failed one.
   * Controls aimed at a finished run are dead and expire here. */
  retryUndelivered(now = Date.now()): void {
    for (const { message, run } of this.store.listUndeliveredMessages()) {
      if (!run) continue;
      // Expiring a dead control is not a retry, so it ignores the backoff.
      if (isTerminal(run.state)) {
        message.state = "expired";
        message.error = "run finished before delivery completed";
        this.store.saveMessage(message);
        this.changed(message);
        continue;
      }
      if ((message.nextAttemptAt ?? 0) > now) continue;
      const target = message.toSessionId || run.targetSessionId;
      if (target) this.deliver(message, target);
    }
  }

  private create(
    run: TaskRun,
    kind: TaskMessageKind,
    fromSessionId: string,
    toSessionId: string,
    content: string,
  ): TaskMessage {
    const message: TaskMessage = {
      id: newId(),
      runId: run.id,
      kind,
      fromSessionId,
      toSessionId,
      state: "pending",
      content: bounded(content),
      createdAt: Date.now(),
      deliveredAt: null,
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
      // A steer interrupts; a follow-up lands only once the recipient runs out
      // of tool calls.
      ...(message.kind === "follow_up" ? {} : { callbackMode: "steer" as const }),
    };
  }

  /** Both ends are told. */
  private told(message: TaskMessage, why: string): void {
    this.unreachable(message.toSessionId, `a ${message.kind} from run ${message.runId}`, why);
    if (message.fromSessionId && message.fromSessionId !== message.toSessionId) {
      this.unreachable(message.fromSessionId, `your ${message.kind} on run ${message.runId}`, why);
    }
  }

  private format(message: TaskMessage, run: TaskRun): string {
    return `Task guidance for "${run.context.definition.name}"\nRun: ${run.id}\nMessage: ${message.id}\n\n${message.content}`;
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
