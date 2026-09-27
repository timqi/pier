import { describe, expect, it } from "vitest";
import { parseCommand, settingsDraft } from "./commands.js";

describe("IM command parsing", () => {
  it("ignores ordinary text", () => {
    expect(parseCommand("ship it")).toBeNull();
    expect(parseCommand("what about /tmp?")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("%")).toBeNull();
    expect(parseCommand("100% sure")).toBeNull();
  });

  it("takes `%` as it takes `/`", () => {
    expect(parseCommand(" %STOP ")).toEqual({ name: "stop", args: "" });
    expect(parseCommand("%bind ab-CD")).toEqual({ name: "bind", args: "ab-CD" });
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
  it("takes `/s <text>` and `%s <text>`, args verbatim", () => {
    expect(settingsDraft("/s what is  new?")).toBe("what is  new?");
    expect(settingsDraft("  /s  review the parser ")).toBe("review the parser");
    expect(settingsDraft("/S ship it")).toBe("ship it");
    expect(settingsDraft("%s ship it")).toBe("ship it");
  });

  it("needs the prefix and a question", () => {
    expect(settingsDraft("s what is new?")).toBeUndefined();
    expect(settingsDraft("s")).toBeUndefined();
    expect(settingsDraft("/s")).toBeUndefined();
    expect(settingsDraft("%s")).toBeUndefined();
    expect(settingsDraft("set the timer")).toBeUndefined();
    expect(settingsDraft("setting up")).toBeUndefined();
    expect(settingsDraft("settings are broken")).toBeUndefined();
    expect(settingsDraft("ship it")).toBeUndefined();
  });
});
