import { describe, expect, it } from "vitest";
import { parseCommand, settingsDraft } from "./commands.js";

describe("IM command parsing", () => {
  it("ignores ordinary text", () => {
    expect(parseCommand("ship it")).toBeNull();
    expect(parseCommand("what about /tmp?")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });

  it("trims both ends before deciding", () => {
    expect(parseCommand("  \n /stop \t ")).toEqual({ name: "stop", args: "" });
  });

  it("lowercases the name and keeps args verbatim", () => {
    expect(parseCommand("/BIND ab-CD")).toEqual({ name: "bind", args: "ab-CD" });
    // Internal spacing survives: a path or a sentence is not re-joined.
    expect(parseCommand("/setcwd /srv/my  project")).toEqual({
      name: "setcwd",
      args: "/srv/my  project",
    });
    expect(parseCommand("/say line one\nline two")).toEqual({
      name: "say",
      args: "line one\nline two",
    });
  });
});

describe("the configure-first trigger", () => {
  it("takes `s <text>` with or without the slash, args verbatim", () => {
    expect(settingsDraft("s what is  new?")).toBe("what is  new?");
    expect(settingsDraft("  /s  review the parser ")).toBe("review the parser");
    expect(settingsDraft("S ship it")).toBe("ship it");
  });

  it("is not a bare `s`, nor the other settings words", () => {
    expect(settingsDraft("s")).toBeUndefined();
    expect(settingsDraft("/s")).toBeUndefined();
    expect(settingsDraft("set the timer")).toBeUndefined();
    expect(settingsDraft("setting up")).toBeUndefined();
    expect(settingsDraft("settings are broken")).toBeUndefined();
    expect(settingsDraft("ship it")).toBeUndefined();
  });
});
