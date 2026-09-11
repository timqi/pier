import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  normalizeModelMenu,
  normalizePublicUrl,
  normalizeTools,
  SettingsStore,
} from "./settings.js";

const EMPTY = {
  publicUrl: "",
  modelMenu: [],
  autoUpdate: false,
  skillsOff: [],
  tools: [],
  customTools: [],
};

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
    expect(store.get()).toEqual(EMPTY);
    expect(store.setPublicUrl("https://pier.example.com")).toEqual({
      ...EMPTY,
      publicUrl: "https://pier.example.com",
    });
    // A restart: the connection is gone, the row is not.
    db.close();
    const reopened = openDb(path);
    expect(new SettingsStore(reopened).get()).toEqual({
      ...EMPTY,
      publicUrl: "https://pier.example.com",
    });
    reopened.close();
  });

  it("overwrites rather than accumulating rows", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    store.setPublicUrl("https://one.example.com");
    store.setPublicUrl("https://two.example.com");
    expect(store.get().publicUrl).toBe("https://two.example.com");
    const { n } = db.prepare("SELECT count(*) AS n FROM settings").get() as { n: number };
    expect(n).toBe(1);
    db.close();
  });

  it("round-trips the model menu and ignores a corrupt row rather than crashing", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    const menu = [
      { provider: "anthropic", id: "claude-opus-4-5", thinking: "high" as const, note: "hardest reasoning" },
    ];
    expect(store.setModelMenu(menu).modelMenu).toEqual(menu);
    // A hand-edited row must not take get() down with it.
    db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'modelMenu'").run();
    expect(store.get().modelMenu).toEqual([]);
    db.prepare("UPDATE settings SET value = '{\"provider\":1}' WHERE key = 'modelMenu'").run();
    expect(store.get().modelMenu).toEqual([]);
    db.close();
  });
});

describe("managed tools", () => {
  it("round-trips the enabled set and ignores a corrupt row rather than crashing", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    expect(store.setTools(["rtk"]).tools).toEqual(["rtk"]);
    db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'tools'").run();
    expect(store.get().tools).toEqual([]);
    db.close();
  });

  it("keeps a declared spec when its switch goes off — they are two decisions", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    const eza = { name: "eza", toml: `spec = "github:eza-community/eza"` };
    store.setCustomTools([eza]);
    expect(store.setTools(["eza"]).customTools).toEqual([eza]);
    expect(store.setTools([]).customTools).toEqual([eza]);
    // A hand-edited row must not take get() down with it.
    db.prepare("UPDATE settings SET value = '[{\"name\":\"eza\"}]' WHERE key = 'customTools'").run();
    expect(store.get().customTools).toEqual([]);
    db.close();
  });

  it("drops a stored tool the catalog has since bundled, and keeps the rest", () => {
    const db = openDb(":memory:");
    const store = new SettingsStore(db);
    // What happened for real: jq was declared by hand, then shipped as a
    // managed tool. The name collision made get() refuse the whole row, so
    // eza stopped applying too and nothing but a WARN said why.
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('customTools',
        '[{"name":"jq","toml":"spec = \\"github:jqlang/jq\\""},{"name":"eza","toml":"spec = \\"github:eza-community/eza\\""}]')`,
    ).run();
    expect(store.get().customTools).toEqual([{ name: "eza", toml: `spec = "github:eza-community/eza"` }]);
    // Not rewritten: a Pier that stops bundling jq finds the declaration back.
    expect(String(db.prepare("SELECT value FROM settings WHERE key = 'customTools'").get()?.value))
      .toContain("jq");
    db.close();
  });

  it("takes a name it does not know, and refuses anything that is not one", () => {
    expect(normalizeTools([" rtk ", "rtk", "future-tool"])).toEqual(["rtk", "future-tool"]);
    for (const bad of ["rtk", [42], [""], ["x".repeat(65)], Array(33).fill("a")]) {
      expect(normalizeTools(bad)).toBeNull();
    }
  });
});

describe("normalizeModelMenu", () => {
  it("accepts entries, trims, and drops an empty note", () => {
    // A level is required, so an entry stored before it was — or exported by an
    // instance that predates it — keeps its pin at the shared default.
    expect(
      normalizeModelMenu([{ provider: " anthropic ", id: " claude-opus-4-5 ", note: "  " }]),
    ).toEqual([{ provider: "anthropic", id: "claude-opus-4-5", thinking: "medium" }]);
    expect(
      normalizeModelMenu([{ provider: "a", id: "x", thinking: "high", note: "hard" }]),
    ).toEqual([{ provider: "a", id: "x", thinking: "high", note: "hard" }]);
  });

  it("rejects rather than repairs anything mis-shaped", () => {
    for (const bad of [
      "not a list",
      [{ provider: "a" }],
      [{ provider: "a", id: 42 }],
      [{ provider: "", id: "x" }],
      [{ provider: "a", id: "x", note: 7 }],
      [{ provider: "a", id: "x", thinking: "warp" }],
      Array.from({ length: 33 }, () => ({ provider: "a", id: "x" })),
    ]) {
      expect(normalizeModelMenu(bad)).toBeNull();
    }
  });
});
