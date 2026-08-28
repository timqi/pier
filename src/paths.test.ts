// One rule, and it cost a debugging session: a second Pier must not inherit
// the first one's agent dir. Everything Pier spawns carries
// PI_CODING_AGENT_DIR, so `PIER_HOME=~/.pier_test npm run dev` typed into
// Pier's own Terminal ran a "separate" instance that wrote its sessions and
// edited its SYSTEM.md inside the production directory.

import { describe, expect, it } from "vitest";
import { resolveAgentDir, resolveHome } from "./paths.js";

const derived = "/home/t/.pier_test/pi";

describe("resolveHome", () => {
  it("takes the value a human set", () => {
    expect(resolveHome("/srv/pier", "/home/t")).toBe("/srv/pier");
  });

  it("treats unset and empty alike — an empty PIER_HOME would make every path relative", () => {
    expect(resolveHome(undefined, "/home/t")).toBe("/home/t/.pier");
    expect(resolveHome("", "/home/t")).toBe("/home/t/.pier");
  });
});

describe("resolveAgentDir", () => {
  it("derives from this instance's PIER_HOME when nothing says otherwise", () => {
    expect(resolveAgentDir({}, derived)).toBe(derived);
  });

  it("obeys a human's override", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/home/t/.pi/agent" }, derived))
      .toBe("/home/t/.pi/agent");
  });

  it("ignores the value another Pier exported for its own children", () => {
    // What a shell inside the production instance hands to `npm run dev`.
    expect(resolveAgentDir({
      PI_CODING_AGENT_DIR: "/home/t/.pier/pi",
      PIER_AGENT_DIR: "/home/t/.pier/pi",
    }, derived)).toBe(derived);
  });

  it("still obeys an override typed inside another Pier's shell", () => {
    // The marker only disqualifies the parent's own value, not a new one.
    expect(resolveAgentDir({
      PI_CODING_AGENT_DIR: "/home/t/.pi/agent",
      PIER_AGENT_DIR: "/home/t/.pier/pi",
    }, derived)).toBe("/home/t/.pi/agent");
  });
});
