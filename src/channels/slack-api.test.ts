// The Socket Mode transport. Payload shapes are covered by slack.test.ts
// against a fake client; what needs its own test is the reconnect loop, which
// is the only place in this file with behaviour rather than plumbing.
//
// Hermetic: `fetch` is stubbed and the socket is injected, so nothing here
// touches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApi, type SocketLike } from "./slack-api.js";

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly acks: string[] = [];
  closed = false;

  send(data: string): void {
    this.acks.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /** Deliver one frame the way Slack would. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[];
let logs: string[];
let opens: number;

/** Every `apps.connections.open` answers with a url; nothing else is called. */
function stubFetch(): void {
  vi.stubGlobal("fetch", (url: string) => {
    if (String(url).includes("apps.connections.open")) opens++;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, url: "wss://fake" }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

const build = (): SlackApi =>
  new SlackApi("xoxb-test", "xapp-test", (m) => logs.push(m), () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });

/** Let the loop advance: it awaits real promises between steps. */
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  sockets = [];
  logs = [];
  opens = 0;
  stubFetch();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("socket mode envelopes", () => {
  it("acknowledges before handing the envelope over", async () => {
    const api = build();
    const seen: string[] = [];
    const handle = await api.connect((env) => {
      // The ack must already be on the wire: a turn outlives Slack's deadline,
      // and anything unacked is redelivered.
      expect(sockets[0]!.acks).toEqual([JSON.stringify({ envelope_id: "e1" })]);
      seen.push(env.type);
    });
    await settle();
    sockets[0]!.deliver({ type: "events_api", envelope_id: "e1", payload: {} });
    expect(seen).toEqual(["events_api"]);
    await handle.close();
  });

  it("acks and swallows `hello`, which is not an event", async () => {
    const api = build();
    const seen: string[] = [];
    const handle = await api.connect((env) => seen.push(env.type));
    await settle();
    sockets[0]!.deliver({ type: "hello" });
    expect(seen).toEqual([]);
    await handle.close();
  });

  it("drops an unparseable frame instead of half-handling it", async () => {
    const api = build();
    const seen: unknown[] = [];
    const handle = await api.connect((env) => seen.push(env));
    await settle();
    sockets[0]!.onmessage?.({ data: "{not json" });
    expect(seen).toEqual([]);
    expect(logs).toContain("unparseable socket frame dropped");
    await handle.close();
  });

  it("reopens after Slack recycles the connection", async () => {
    const api = build();
    const handle = await api.connect(() => {});
    await settle();
    expect(sockets).toHaveLength(1);
    // Slack cycles a connection every few hours; the disconnect is expected.
    sockets[0]!.deliver({ type: "disconnect", reason: "refresh_requested" });
    await settle(2000);
    expect(sockets).toHaveLength(2);
    expect(logs.some((l) => l.includes("refresh_requested"))).toBe(true);
    await handle.close();
  });
});

describe("web api", () => {
  /** Capture the JSON body of every call. */
  const bodies: Record<string, unknown>[] = [];

  const stubCalls = (): void => {
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, ts: "1.1" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
  };

  it("turns link previews off on every message", async () => {
    bodies.length = 0;
    stubCalls();
    // Defaulted in the transport, not the adapter, so no call site can forget:
    // a turn quoting three URLs would otherwise be mostly preview cards.
    await build().postMessage({ channel: "C1", thread_ts: "1.1", text: "see https://example.com" });
    expect(bodies[0]).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  it("sends read methods form-encoded, because JSON is write-only", async () => {
    const seen: { url: string; type: string; body: string }[] = [];
    vi.stubGlobal("fetch", (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ url: String(url), type: init.headers["content-type"]!, body: String(init.body) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, user: { real_name: "Ada" } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const api = build();
    // A JSON body on users.info is ignored, and the missing param comes back as
    // `user_not_found` — which reads like "no such person".
    await api.userName("U1");
    await api.history("C1", { oldest: "1", latest: "2" });
    for (const call of seen) {
      expect(call.type).toContain("application/x-www-form-urlencoded");
    }
    expect(seen[0]!.body).toBe("user=U1");
    expect(seen[1]!.body).toContain("oldest=1");
    // Undefined params are omitted rather than sent as "undefined".
    expect(seen[1]!.body).not.toContain("undefined");
  });

  it("keeps write methods on JSON, which blocks require", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers["content-type"]!);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, ts: "1.1" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await build().postMessage({ channel: "C1", text: "x", blocks: [{ type: "markdown", text: "x" }] });
    expect(seen[0]).toContain("application/json");
  });

  it("drops thread_ts from an update, which chat.update rejects", async () => {
    bodies.length = 0;
    stubCalls();
    await build().updateMessage({ channel: "C1", ts: "1.1", thread_ts: "9.9", text: "x" });
    expect(bodies[0]).not.toHaveProperty("thread_ts");
    expect(bodies[0]).toMatchObject({ channel: "C1", ts: "1.1" });
  });

  it("treats an already-applied reaction as success", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
          headers: { "content-type": "application/json" },
        }),
      ));
    // The 👀 is already where we want it; that is not a failure.
    await expect(build().addReaction("C1", "1.1", "eyes")).resolves.toBeUndefined();
  });

  it("surfaces a real API error", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          headers: { "content-type": "application/json" },
        }),
      ));
    await expect(build().postMessage({ channel: "C1", text: "x" }))
      .rejects.toThrow(/missing_scope/);
  });
});

describe("reconnect backoff", () => {
  it("does not hot-loop when a socket dies the moment it opens", async () => {
    // Slack answers "too many connections" by accepting the socket and closing
    // it, so the promise resolves normally and never reaches the catch. Without
    // a floor this hammers apps.connections.open as fast as the event loop runs.
    const api = build();
    const handle = await api.connect(() => {});
    for (let i = 0; i < 5; i++) {
      await settle();
      sockets.at(-1)!.close();
      await settle(1);
    }
    // Five instant deaths in ~5ms: a hot loop would have opened far more.
    expect(opens).toBeLessThanOrEqual(2);
    await handle.close();
  });

  it("backs off exponentially, then recovers after a healthy connection", async () => {
    const api = build();
    const handle = await api.connect(() => {});
    await settle();
    expect(opens).toBe(1);

    // Each death is immediate, so each wait should be longer than the last.
    sockets.at(-1)!.close();
    await settle(1000);
    expect(opens).toBe(2);
    sockets.at(-1)!.close();
    await settle(1000); // not enough: the second wait is 2s
    expect(opens).toBe(2);
    await settle(1000);
    expect(opens).toBe(3);

    // A connection that lived past the healthy threshold resets the floor.
    await settle(10_000);
    sockets.at(-1)!.close();
    await settle(1000);
    expect(opens).toBe(4);
    await handle.close();
  });

  it("stops reconnecting once closed", async () => {
    const api = build();
    const handle = await api.connect(() => {});
    await settle();
    await handle.close();
    expect(sockets[0]!.closed).toBe(true);
    const after = opens;
    await settle(60_000);
    expect(opens).toBe(after);
  });

  it("opens no socket when stop lands while the url call is in flight", async () => {
    // reload() closes and rebuilds immediately; a socket opened after that is
    // one nobody holds a reference to.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("apps.connections.open")) opens++;
      await gate;
      return new Response(JSON.stringify({ ok: true, url: "wss://fake" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const api = build();
    const handle = await api.connect(() => {});
    await settle();
    await handle.close();
    release();
    await settle(1000);
    expect(sockets).toHaveLength(0);
  });
});
