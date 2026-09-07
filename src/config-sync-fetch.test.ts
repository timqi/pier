import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSourceUrl, CONFIG_SYNC_BYTES, downloadConfig } from "./config-sync-fetch.js";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function reply(status: number, body: string, headers: Record<string, string> = { "content-type": "application/json", etag: '"test"' }): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}
const requested = (): string[] => fetchMock.mock.calls.map((call) => (call[0] as URL).href);

describe("configuration source fetch boundary", () => {
  it("requires HTTPS without embedded credentials/fragments", () => {
    for (const raw of ["file:///etc/passwd", "http://example.com", "https://u:p@example.com", "https://example.com/#token", "bad"]) {
      expect(() => configSourceUrl(raw)).toThrow();
    }
    expect(configSourceUrl(" https://example.com/config-sync/token ").href).toBe("https://example.com/config-sync/token");
  });

  it("sends the conditional request to the source URL", async () => {
    fetchMock.mockResolvedValue(reply(200, "{}"));
    expect(await downloadConfig("https://example.com:8443/config-sync/token", '"old"', AbortSignal.timeout(1000)))
      .toEqual({ status: 200, etag: '"test"', body: "{}" });
    expect(requested()).toEqual(["https://example.com:8443/config-sync/token"]);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "GET", redirect: "manual",
      headers: { accept: "application/json", "if-none-match": '"old"' },
    }));
  });

  it("reaches private and loopback sources", async () => {
    fetchMock.mockResolvedValue(reply(304, ""));
    expect(await downloadConfig("https://pier.internal/config-sync/token", '"old"', AbortSignal.timeout(1000)))
      .toEqual({ status: 304, etag: '"test"', body: "" });
  });

  it("follows HTTPS redirects, including relative ones, up to a ceiling", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(302, "", { location: "https://cdn.example.com/token" }))
      .mockResolvedValueOnce(reply(301, "", { location: "/moved/token" }))
      .mockResolvedValueOnce(reply(200, "{}"));
    expect(await downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000)))
      .toEqual({ status: 200, etag: '"test"', body: "{}" });
    expect(requested()).toEqual([
      "https://example.com/token", "https://cdn.example.com/token", "https://cdn.example.com/moved/token",
    ]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(302, "", { location: "https://example.com/loop" }));
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("too many times");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("refuses a redirect that leaves HTTPS", async () => {
    fetchMock.mockResolvedValue(reply(302, "", { location: "http://169.254.169.254/" }));
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("not HTTPS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not accept HTML or read oversized JSON", async () => {
    fetchMock.mockResolvedValue(reply(200, "html", { "content-type": "text/html" }));
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("JSON");
    fetchMock.mockResolvedValue(reply(200, "x".repeat(CONFIG_SYNC_BYTES + 1)));
    await expect(downloadConfig("https://example.com/token", null, AbortSignal.timeout(1000))).rejects.toThrow("1 MiB");
  });

  it("reports cancellation and refuses revoked links without exposing the token", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = downloadConfig("https://example.com/private-token", null, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(404, ""));
    await expect(downloadConfig("https://example.com/private-token", null, AbortSignal.timeout(1000))).rejects.toThrow("revoked");
  });
});
