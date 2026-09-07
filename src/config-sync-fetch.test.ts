import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { configSourceUrl, CONFIG_SYNC_BYTES, downloadConfig, publicConfigAddress } from "./config-sync-fetch.js";

beforeEach(() => { mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); });
afterEach(() => vi.resetAllMocks());

function response(statusCode: number, body: string, headers: Record<string, string> = { "content-type": "application/json", etag: '"test"' }): void {
  mocks.request.mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
    const res = Object.assign(new EventEmitter(), { statusCode, headers, destroy: (err?: Error) => { if (err) res.emit("error", err); } });
    return Object.assign(new EventEmitter(), { end() {
      callback(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    } });
  });
}

describe("configuration source fetch boundary", () => {
  it("requires HTTPS without embedded credentials/fragments", () => {
    for (const raw of ["file:///etc/passwd", "http://example.com", "https://u:p@example.com", "https://example.com/#token", "bad"]) {
      expect(() => configSourceUrl(raw)).toThrow();
    }
    expect(configSourceUrl(" https://example.com/config-sync/token ").href).toBe("https://example.com/config-sync/token");
  });

  it("rejects loopback, private, link-local, metadata, multicast and address-translation ranges", () => {
    for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.2", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200",
      "224.0.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "fc00::1", "fe80::1", "fec0::1", "ff02::1", "2002:7f00:1::", "nonsense"]) {
      expect(publicConfigAddress(address), address).toBe(false);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicConfigAddress(address)).toBe(true);
  });

  it("pins the validated address but keeps TLS identity and Host at the source hostname", async () => {
    response(200, "{}");
    expect(await downloadConfig("https://example.com:8443/config-sync/token", '"old"', AbortSignal.timeout(1000)))
      .toEqual({ status: 200, etag: '"test"', body: "{}" });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "8.8.8.8", port: "8443", servername: "example.com", path: "/config-sync/token",
      headers: { host: "example.com:8443", accept: "application/json", "if-none-match": '"old"' },
      checkServerIdentity: expect.any(Function),
    }), expect.any(Function));
  });

  it("refuses mixed public/private DNS answers before any request", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("public address");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not follow redirects, accept HTML, or read oversized JSON", async () => {
    response(302, "", { location: "http://169.254.169.254/" });
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("HTTP 302");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    response(200, "html", { "content-type": "text/html" });
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("JSON");
    response(200, "x".repeat(CONFIG_SYNC_BYTES + 1));
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("1 MiB");
  });

  it("times out DNS resolution and refuses revoked links without exposing the token", async () => {
    mocks.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = downloadConfig("https://example.com/private-token", null, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    response(404, "");
    await expect(downloadConfig("https://example.com/private-token", null, AbortSignal.timeout(1000))).rejects.toThrow("revoked");
  });
});
