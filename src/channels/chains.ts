// Ordering: one promise chain per conversation.
//
// Messages from different chats are handled concurrently — a slow download must
// not stall another group — but messages within one chat strictly in arrival
// order, because a steer overtaking the message it interrupts reorders the
// conversation.
//
// Two rules live here because both adapters got to write them once and neither
// should write them twice:
//
//  - Every link needs its own `catch`. One rejected handler otherwise poisons
//    the chain and silences that chat for the life of the process — an ordering
//    mechanism that fails closed, permanently.
//  - `drain()` is bounded. `runtime.reload()` runs on the Console's save, so a
//    stuck handler must not hold that request open.

export class Chains {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly log: (message: string) => void,
    /**
     * How many conversations may be in flight before a new one queues behind an
     * existing chain. Bounds concurrency (open sockets, downloads); a transport
     * that can also slow its source down should do that separately.
     */
    private readonly maxActive = Infinity,
  ) {}

  get size(): number {
    return this.active.size;
  }

  /** Append to a conversation's chain, dropping the entry once it drains. */
  run(key: string, task: () => Promise<void>): void {
    const mine = this.active.get(key);
    // A conversation with a chain already waits on itself; only a new one has
    // to wait for a slot. `active` is non-empty whenever the cap is hit, so the
    // race always settles.
    const start = mine ??
      (this.active.size >= this.maxActive
        ? Promise.race(this.active.values()).catch(() => {})
        : Promise.resolve());
    const next = start
      .then(task)
      .catch((err) => this.log(`handler failed in ${key}: ${String(err)}`));
    this.active.set(key, next);
    void next.then(() => {
      if (this.active.get(key) === next) this.active.delete(key);
    });
  }

  /** Wait for the oldest in-flight chain — the backpressure primitive. */
  oldest(): Promise<unknown> {
    return Promise.race(this.active.values()).catch(() => {});
  }

  /**
   * Let in-flight work finish before a replacement adapter starts, but never
   * wait forever: two adapters handling one message would prompt twice, and a
   * hung handler holding up a config save is worse than either.
   */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      Promise.allSettled(this.active.values()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
