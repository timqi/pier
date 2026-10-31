// The command key is the platform's one: ⌘ on a Mac, where bare ⌃B in the
// composer is emacs's backward-char and must reach it; Ctrl everywhere else.
// The hint says the same key the chord listens for.

import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./dom.testkit.js";

type Shortcut = typeof import("./shortcut.js");

/** The module as a browser on `ua` loads it: the platform is read once, on import. */
async function on(ua: string): Promise<Shortcut> {
  vi.resetModules();
  installDom();
  vi.stubGlobal("navigator", { userAgent: ua });
  return import("./shortcut.js");
}

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  Object.assign(new Event("keydown", { cancelable: true }), { altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...init }) as unknown as KeyboardEvent;

afterEach(() => vi.unstubAllGlobals());

describe("commandKey", () => {
  it("is ⌘ alone on a Mac: ⌃B stays the composer's", async () => {
    const { commandKey } = await on(MAC);
    expect(commandKey(key({ key: "b", metaKey: true }))).toBe(true);
    expect(commandKey(key({ key: "b", ctrlKey: true }))).toBe(false);
    expect(commandKey(key({ key: "b", metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("is Ctrl alone elsewhere", async () => {
    const { commandKey } = await on(LINUX);
    expect(commandKey(key({ key: "b", ctrlKey: true }))).toBe(true);
    expect(commandKey(key({ key: "b", metaKey: true }))).toBe(false);
  });
});

describe("chord", () => {
  it("fires on the platform's key and lets the other modifier through", async () => {
    const { chord } = await on(MAC);
    const run = vi.fn();
    chord("b", run);
    const ctrl = key({ key: "b", ctrlKey: true });
    document.dispatchEvent(ctrl);
    expect(run).not.toHaveBeenCalled();
    expect(ctrl.defaultPrevented).toBe(false);
    const meta = key({ key: "b", metaKey: true });
    document.dispatchEvent(meta);
    expect(run).toHaveBeenCalledTimes(1);
    expect(meta.defaultPrevented).toBe(true);
  });

  it("is Ctrl off a Mac", async () => {
    const { chord } = await on(LINUX);
    const run = vi.fn();
    chord("shift+o", run);
    document.dispatchEvent(key({ key: "O", metaKey: true, shiftKey: true }));
    expect(run).not.toHaveBeenCalled();
    document.dispatchEvent(key({ key: "O", ctrlKey: true, shiftKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("chordLabel", () => {
  it("names the platform's key", async () => {
    expect((await on(MAC)).chordLabel("shift+o")).toBe("⌘⇧O");
    expect((await on(LINUX)).chordLabel("shift+o")).toBe("Ctrl+Shift+O");
    expect((await on(LINUX)).chordLabel("b")).toBe("Ctrl+B");
  });
});
