import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizePublicUrl, SettingsStore } from "./settings.js";

const file = (): string => join(mkdtempSync(join(tmpdir(), "pier-settings-")), "settings.json");

describe("normalizePublicUrl", () => {
  it("accepts what a link can be built from, and strips what it cannot carry", () => {
    expect(normalizePublicUrl("https://pier.example.com/")).toBe("https://pier.example.com");
    expect(normalizePublicUrl("  pier.example.com  ")).toBe("https://pier.example.com");
    expect(normalizePublicUrl("http://192.168.1.5:3141")).toBe("http://192.168.1.5:3141");
    expect(normalizePublicUrl("https://example.com/pier//")).toBe("https://example.com/pier");
    expect(normalizePublicUrl("")).toBe("");
  });

  it("rejects rather than repairs anything that would produce a dead link", () => {
    for (const bad of ["ftp://example.com", "https://example.com/?a=1", "https://e.com/#x", "https://u:p@e.com", "not a url"]) {
      expect(normalizePublicUrl(bad)).toBeNull();
    }
  });
});

describe("SettingsStore", () => {
  it("starts empty, persists a write, and reads it back on restart", () => {
    const path = file();
    const store = new SettingsStore(path);
    expect(store.get()).toEqual({ publicUrl: "" });
    expect(store.setPublicUrl("https://pier.example.com")).toEqual({
      publicUrl: "https://pier.example.com",
    });
    expect(new SettingsStore(path).get()).toEqual({ publicUrl: "https://pier.example.com" });
  });

  it("reports a broken file and treats it as empty", async () => {
    const path = file();
    writeFileSync(path, "{ not json");
    // Reported through log.ts, so the assertion is on the stream it writes to
    // (the suite runs at PIER_LOG=silent, hence the threshold below).
    vi.stubEnv("PIER_LOG", "warn");
    vi.resetModules();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { SettingsStore: Fresh } = await import("./settings.js");
    expect(new Fresh(path).get()).toEqual({ publicUrl: "" });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
