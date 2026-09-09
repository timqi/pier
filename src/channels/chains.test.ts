// What the cap has to mean: not how many conversations are tracked, but how
// many handlers are inside their body at once — measured, never timed.

import { describe, expect, it } from "vitest";
import { Chains } from "./chains.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets the microtask queue settle without introducing a timer. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("Chains", () => {
  it("never runs more handlers at once than maxActive, under a burst", async () => {
    const chains = new Chains(() => {}, 1);
    const keys = ["a", "b", "c", "d"];
    const gates = new Map(keys.map((key) => [key, deferred()]));
    const ran: string[] = [];
    let running = 0;
    let peak = 0;

    for (const key of keys) {
      chains.run(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        ran.push(key);
        await gates.get(key)!.promise;
        running -= 1;
      });
    }

    // Release one gate at a time: each release may admit exactly one waiter.
    for (let i = 0; i < keys.length; i++) {
      await settle();
      expect(peak).toBe(1);
      expect(ran.length).toBe(i + 1);
      gates.get(ran[i]!)!.resolve();
    }

    await chains.drain(1000);
    expect(ran.sort()).toEqual(keys);
    expect(running).toBe(0);
    expect(chains.size).toBe(0);
  });

  it("admits a fresh conversation once a slot is released", async () => {
    const chains = new Chains(() => {}, 1);
    const first = deferred();
    const ran: string[] = [];
    chains.run("a", async () => {
      ran.push("a");
      await first.promise;
    });
    await settle();
    // The cap is held even when the waiter arrives long after the burst.
    chains.run("b", async () => void ran.push("b"));
    await settle();
    expect(ran).toEqual(["a"]);
    first.resolve();
    await chains.drain(1000);
    expect(ran).toEqual(["a", "b"]);
    expect(chains.size).toBe(0);
  });

  it("keeps one conversation in arrival order without taking a second slot", async () => {
    const chains = new Chains(() => {}, 1);
    const gates = [deferred(), deferred()];
    const order: string[] = [];
    chains.run("a", async () => {
      order.push("first");
      await gates[0]!.promise;
      order.push("first done");
    });
    chains.run("a", async () => {
      order.push("second");
      await gates[1]!.promise;
    });
    await settle();
    expect(order).toEqual(["first"]);
    gates[0]!.resolve();
    gates[1]!.resolve();
    await chains.drain(1000);
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("a rejecting handler is logged and frees its slot", async () => {
    const logs: string[] = [];
    const chains = new Chains((m) => logs.push(m), 1);
    const ran: string[] = [];
    chains.run("a", () => Promise.reject(new Error("boom")));
    chains.run("b", async () => void ran.push("b"));
    await chains.drain(1000);
    expect(logs).toEqual(["handler failed in a: Error: boom"]);
    expect(ran).toEqual(["b"]);
    expect(chains.size).toBe(0);
  });

  it("drain returns on its bound rather than waiting for a stuck handler", async () => {
    const chains = new Chains(() => {}, 1);
    chains.run("a", () => new Promise<void>(() => {}));
    await chains.drain(5);
    expect(chains.size).toBe(1);
  });
});
