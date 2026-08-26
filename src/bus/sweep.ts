// Run scope is ephemeral, and nothing else can clean up after it: once a run
// tree is terminal no caller's scope set resolves to it, so its events are
// invisible to every read and unreachable by the tool's archive (whose anchor
// must be an event the caller sees) while still sitting in the live table,
// every topic GLOB scan and the search index. This pass is the one thing that
// can still move them out.

import { logger } from "../log.js";
import type { BusStore } from "./store.js";

const log = logger("bus");

/** Hourly: the events cost only size, and a tree that ended a minute ago is
 * not urgent. */
export const SWEEP_INTERVAL_MS = 3_600_000;

export class BusSweep {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly events: BusStore,
    /** Whether a run tree is over. Injected because run state belongs to
     * tasks and the bus imports neither area (AGENTS.md seams) — main.ts
     * answers it from the task store. */
    private readonly isRunDead: (rootRunId: string) => boolean,
    /** Rows moved out of the live table is a durable change the Console's Bus
     * view shows; nobody made a tool call, so this pass is the only thing
     * that can say so. */
    private readonly announce: () => void = () => {},
    /** The capability switch: off, the bus is frozen — the tables stay exactly
     * as the operator left them. */
    private readonly enabled: () => boolean = () => true,
  ) {}

  /** How many scopes were swept. Loud per scope (AGENTS.md 5b) and silent
   * only when there was nothing to do, which is the ordinary hour. */
  sweep(): number {
    if (!this.enabled()) return 0;
    let swept = 0;
    for (const scope of this.events.runScopes()) {
      if (!this.isRunDead(scope.slice("run:".length))) continue;
      try {
        const moved = this.events.archiveDeadRunScope(scope);
        swept++;
        log.info(`archived dead run scope ${scope}: ${String(moved)} events moved — its run tree is terminal, so nothing resolved to that scope any more`);
      } catch (err) {
        // One scope's failure must not silently take the rest of the pass
        // with it, and must not look like a scope that was simply not dead.
        log.error(`could not archive dead run scope ${scope}`, err);
      }
    }
    if (swept > 0) this.announce();
    return swept;
  }

  start(intervalMs = SWEEP_INTERVAL_MS): void {
    this.#timer = setInterval(() => { this.sweep(); }, intervalMs);
    this.#timer.unref();
    this.sweep();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
