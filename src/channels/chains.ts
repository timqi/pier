// One promise chain per conversation: chats run concurrently, but within one
// chat strictly in arrival order, or a steer overtakes the message it interrupts.

export class Chains {
  private readonly active = new Map<string, Promise<void>>();
  private held = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly log: (message: string) => void,
    /** Bounds concurrency (sockets, downloads), not the source's backlog. */
    private readonly maxActive = Infinity,
  ) {}

  get size(): number {
    return this.active.size;
  }

  run(key: string, task: () => Promise<void>): void {
    // A conversation owns one slot for the life of its chain, so a follow-up
    // message queues behind its own handler instead of claiming a second.
    const mine = this.active.get(key);
    const next = (mine ?? this.acquire())
      .then(task)
      // Every link catches: one rejection would otherwise silence the chat for good.
      .catch((err) => this.log(`handler failed in ${key}: ${String(err)}`));
    this.active.set(key, next);
    void next.then(() => {
      if (this.active.get(key) !== next) return;
      this.active.delete(key);
      this.release();
    });
  }

  /** Reserved synchronously, so a burst of `run` calls cannot all pass the cap. */
  private acquire(): Promise<void> {
    if (this.held < this.maxActive) {
      this.held += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    // The slot moves to one waiter rather than being counted back, which is
    // what keeps a release from waking the whole queue.
    const next = this.waiting.shift();
    if (next) next();
    else this.held -= 1;
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
