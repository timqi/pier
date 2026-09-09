// One promise chain per conversation: chats run concurrently, but within one
// chat strictly in arrival order, or a steer overtakes the message it interrupts.

export class Chains {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly log: (message: string) => void,
    /** Bounds concurrency (sockets, downloads), not the source's backlog. */
    private readonly maxActive = Infinity,
  ) {}

  get size(): number {
    return this.active.size;
  }

  run(key: string, task: () => Promise<void>): void {
    const mine = this.active.get(key);
    // Only a new conversation waits for a slot; `active` is non-empty whenever
    // the cap is hit, so the race always settles.
    const start = mine ??
      (this.active.size >= this.maxActive
        ? Promise.race(this.active.values()).catch(() => {})
        : Promise.resolve());
    const next = start
      .then(task)
      // Every link catches: one rejection would otherwise silence the chat for good.
      .catch((err) => this.log(`handler failed in ${key}: ${String(err)}`));
    this.active.set(key, next);
    void next.then(() => {
      if (this.active.get(key) === next) this.active.delete(key);
    });
  }

  /** The backpressure primitive. */
  oldest(): Promise<unknown> {
    return Promise.race(this.active.values()).catch(() => {});
  }

  /** Two adapters handling one message would prompt twice; a hung handler
   *  holding up the Console's save is worse than either, hence the bound. */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      Promise.allSettled(this.active.values()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
