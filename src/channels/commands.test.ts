import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

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

  it("reports the @target so the caller can decide if it is theirs", () => {
    expect(parseCommand("/stop@pierbot")).toEqual({ name: "stop", args: "", target: "pierbot" });
    expect(parseCommand("/stop@otherbot now")).toEqual({
      name: "stop",
      args: "now",
      target: "otherbot",
    });
    expect(parseCommand("/stop")).not.toHaveProperty("target");
  });
});
