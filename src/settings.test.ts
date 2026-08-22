import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { normalizePublicUrl, SettingsStore } from "./settings.js";

const dbPath = (): string => join(mkdtempSync(join(tmpdir(), "pier-settings-")), "pier.db");

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
    const path = dbPath();
    const db = openDb(path);
    const store = new SettingsStore(db);
    expect(store.get()).toEqual({ publicUrl: "" });
    expect(store.setPublicUrl("https://pier.example.com")).toEqual({
      publicUrl: "https://pier.example.com",
    });
    // A restart: the connection is gone, the row is not.
    db.close();
    const reopened = openDb(path);
    expect(new SettingsStore(reopened).get()).toEqual({ publicUrl: "https://pier.example.com" });
    reopened.close();
  });

  it("overwrites rather than accumulating rows", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    store.setPublicUrl("https://one.example.com");
    store.setPublicUrl("https://two.example.com");
    expect(store.get()).toEqual({ publicUrl: "https://two.example.com" });
    const { n } = db.prepare("SELECT count(*) AS n FROM settings").get() as { n: number };
    expect(n).toBe(1);
    db.close();
  });
});
