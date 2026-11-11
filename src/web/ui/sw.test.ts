// The worker's fetch handler: which requests it answers itself, and which it leaves to the network.
import { expect, it, vi } from "vitest";
import source from "./public/sw.js?raw";

type FetchEvent = { request: { mode: string; method: string; keepalive: boolean }; preloadResponse?: Promise<unknown>; respondWith: ReturnType<typeof vi.fn> };

function fetchHandler(fetcher: (request: unknown) => Promise<unknown>): (event: FetchEvent) => void {
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const self = { location: { origin: "https://pier.test" }, addEventListener: (type: string, fn: (event: FetchEvent) => void) => listeners.set(type, fn) };
  new Function("self", "fetch", source)(self, fetcher);
  return listeners.get("fetch")!;
}

const event = (request: Partial<FetchEvent["request"]>): FetchEvent =>
  ({ request: { mode: "cors", method: "GET", keepalive: false, ...request }, respondWith: vi.fn() });

// A page that leaves does not outlive its request (drawer.ts sendAll): the worker does.
it("sends a keepalive request itself and leaves every other API request to the network", async () => {
  const answer = { status: 200 };
  const fetcher = vi.fn(async () => answer);
  const handle = fetchHandler(fetcher);

  const close = event({ method: "POST", keepalive: true });
  handle(close);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(close.request);
  await expect(close.respondWith.mock.calls[0]![0]).resolves.toBe(answer);

  for (const plain of [event({ method: "POST" }), event({})]) {
    handle(plain);
    expect(plain.respondWith).not.toHaveBeenCalled();
  }
  expect(fetcher).toHaveBeenCalledOnce();
});

it("answers a navigation from the network, a failed one with the offline page", async () => {
  const handle = fetchHandler(vi.fn(async () => { throw new TypeError("offline"); }));
  const navigation = { ...event({ mode: "navigate" }), preloadResponse: Promise.resolve(undefined) };
  vi.stubGlobal("Response", class { constructor(readonly body: string, readonly init: { status: number }) {} });
  try {
    handle(navigation);
    const page = await navigation.respondWith.mock.calls[0]![0] as { body: string; init: { status: number } };
    expect(page.init.status).toBe(503);
    expect(page.body).toContain("Pier is unreachable");
  } finally {
    vi.unstubAllGlobals();
  }
});
