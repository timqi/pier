import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  normalizeModelMenu,
  normalizePublicUrl,
  normalizeTerminalInitCommand,
  SettingsStore,
} from "./settings.js";

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
    expect(store.get()).toEqual({ publicUrl: "", modelMenu: [], autoUpdate: false, terminalInitCommand: "" });
    expect(store.setPublicUrl("https://pier.example.com")).toEqual({
      publicUrl: "https://pier.example.com",
      modelMenu: [],
      autoUpdate: false,
      terminalInitCommand: "",
    });
    // A restart: the connection is gone, the row is not.
    db.close();
    const reopened = openDb(path);
    expect(new SettingsStore(reopened).get()).toEqual({
      publicUrl: "https://pier.example.com",
      modelMenu: [],
      autoUpdate: false,
      terminalInitCommand: "",
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
    const menu = [{ provider: "anthropic", id: "claude-opus-4-5", note: "hardest reasoning" }];
    expect(store.setModelMenu(menu).modelMenu).toEqual(menu);
    // A hand-edited row must not take get() down with it.
    db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'modelMenu'").run();
    expect(store.get().modelMenu).toEqual([]);
    db.prepare("UPDATE settings SET value = '{\"provider\":1}' WHERE key = 'modelMenu'").run();
    expect(store.get().modelMenu).toEqual([]);
    db.close();
  });
});

describe("normalizeTerminalInitCommand", () => {
  it("keeps one trimmed line", () => {
    expect(normalizeTerminalInitCommand('  tmux new -As "$(basename $PWD)"  ')).toBe(
      'tmux new -As "$(basename $PWD)"',
    );
    expect(normalizeTerminalInitCommand("   ")).toBe("");
  });

  it("rejects what a tty would read as more than that line", () => {
    expect(normalizeTerminalInitCommand("tmux new\nrm -rf /")).toBeNull();
    expect(normalizeTerminalInitCommand("tmux\tnew")).toBeNull();
    expect(normalizeTerminalInitCommand("echo \u0007")).toBeNull();
    expect(normalizeTerminalInitCommand("x".repeat(501))).toBeNull();
  });
});

describe("normalizeModelMenu", () => {
  it("accepts entries, trims, and drops an empty note", () => {
    expect(
      normalizeModelMenu([{ provider: " anthropic ", id: " claude-opus-4-5 ", note: "  " }]),
    ).toEqual([{ provider: "anthropic", id: "claude-opus-4-5" }]);
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
