import { describe, expect, it, vi } from "vitest";
import { EventHub } from "./hub.js";

describe("EventHub", () => {
  it("stamps monotonic per-session seq and fans out", () => {
    const hub = new EventHub();
    const seen: number[] = [];
    hub.subscribe("s1", (e) => seen.push(e.seq));
    hub.emit("s1", { type: "turn-start" });
    hub.emit("s2", { type: "turn-start" }); // independent counter
    hub.emit("s1", { type: "state", state: "idle" });
    expect(seen).toEqual([1, 2]);
    expect(hub.replay("s1", 0).at(-1)?.sessionId).toBe("s1");
    expect(hub.replay("s2", 0).map((x) => x.seq)).toEqual([1]);
  });

  it("a throwing subscriber does not stop later subscribers or unwind emit", () => {
    // emit() runs on the emitter's stack — Pi's dispatch path for session
    // events — so a bad consumer must cost only itself.
    const hub = new EventHub();
    const good = vi.fn();
    hub.subscribe("s", () => {
      throw new Error("boom");
    });
    hub.subscribe("s", good);
    expect(() => hub.emit("s", { type: "turn-start" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    const workspace = vi.fn();
    hub.subscribeWorkspace(() => {
      throw new Error("boom");
    });
    hub.subscribeWorkspace(workspace);
    expect(() => hub.emitWorkspace({ type: "sessions-changed" })).not.toThrow();
    expect(workspace).toHaveBeenCalledTimes(1);
  });

  it("replays only events after the given seq", () => {
    const hub = new EventHub();
    for (let i = 0; i < 5; i++) hub.emit("s", { type: "turn-start" });
    expect(hub.replay("s", 3).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("ring buffer drops oldest beyond 1000, oldest first, still filtered by seq", () => {
    const hub = new EventHub();
    for (let i = 0; i < 1005; i++) hub.emit("s", { type: "turn-start" });
    const events = hub.replay("s", 0);
    expect(events).toHaveLength(1000);
    expect(events[0]?.seq).toBe(6);
    expect(events.at(-1)?.seq).toBe(1005);
    expect(events.every((e, i) => i === 0 || e.seq === events[i - 1]!.seq + 1)).toBe(true);
    // A wrapped ring still answers `seq > after`, and an id older than the
    // ring gets what is left rather than nothing.
    expect(hub.replay("s", 1003).map((e) => e.seq)).toEqual([1004, 1005]);
    expect(hub.replay("s", 2)[0]?.seq).toBe(6);
    expect(hub.replay("s", 1005)).toEqual([]);
  });

  it("text deltas fan out live but never enter the ring", () => {
    // A long reply is thousands of deltas: buffering them would evict the
    // turn-start/tool/turn-end events a reconnecting client replays for.
    const hub = new EventHub();
    const seen: string[] = [];
    hub.subscribe("s", (e) => seen.push(e.type));
    hub.emit("s", { type: "turn-start" });
    for (let i = 0; i < 2000; i++) hub.emit("s", { type: "text-delta", text: "x" });
    hub.emit("s", { type: "thinking-delta", text: "h" });
    hub.emit("s", { type: "turn-end", text: "xxx" });
    expect(seen).toHaveLength(2003); // every one of them was delivered live
    // Thinking must survive a native EventSource reconnect: it does not reload
    // the transcript snapshot, and turn-end only restores the final text.
    expect(hub.replay("s", 0).map((e) => e.seq)).toEqual([1, 2002, 2003]);
    expect(hub.lastSeq("s")).toBe(2003); // deltas still take their number
  });

  it("fans workspace events out to every client", () => {
    const hub = new EventHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribeWorkspace(a);
    const unsub = hub.subscribeWorkspace(b);
    hub.emitWorkspace({ type: "sessions-changed" });
    unsub();
    hub.emitWorkspace({ type: "session-state", sessionId: "s1", state: "streaming" });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
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
