import { describe, expect, it, vi } from "vitest";
import { EventHub } from "./hub.js";

describe("EventHub", () => {
  it("stamps monotonic per-session seq and fans out", () => {
    const hub = new EventHub();
    const seen: number[] = [];
    hub.subscribe("s1", (e) => seen.push(e.seq));
    hub.emit("s1", { type: "turn-start" });
    hub.emit("s2", { type: "turn-start" }); // independent counter
    const e = hub.emit("s1", { type: "state", state: "idle" });
    expect(seen).toEqual([1, 2]);
    expect(e.sessionId).toBe("s1");
    expect(hub.replay("s2", 0).map((x) => x.seq)).toEqual([1]);
  });

  it("replays only events after the given seq", () => {
    const hub = new EventHub();
    for (let i = 0; i < 5; i++) hub.emit("s", { type: "turn-start" });
    expect(hub.replay("s", 3).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("ring buffer drops oldest beyond 1000", () => {
    const hub = new EventHub();
    for (let i = 0; i < 1005; i++) hub.emit("s", { type: "turn-start" });
    const events = hub.replay("s", 0);
    expect(events).toHaveLength(1000);
    expect(events[0]?.seq).toBe(6);
  });

  it("unsubscribe stops delivery", () => {
    const hub = new EventHub();
    const fn = vi.fn();
    const unsub = hub.subscribe("s", fn);
    hub.emit("s", { type: "turn-start" });
    unsub();
    hub.emit("s", { type: "turn-start" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
