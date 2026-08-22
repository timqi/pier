// The threshold and the two output shapes are read by machines (journalctl -p,
// a grep in a terminal), so they are worth pinning. The module reads its
// environment once at import, so every case imports it fresh.

import { afterEach, describe, expect, it, vi } from "vitest";

async function capture(
  env: Record<string, string | undefined>,
  use: (logger: (area: string) => import("./log.js").Logger) => void,
): Promise<{ out: string[]; err: string[] }> {
  // The suite runs with PIER_LOG=silent (vitest.config.ts), so every case
  // states the threshold it is testing rather than inheriting that one.
  for (const [key, value] of Object.entries({ PIER_LOG: undefined, ...env })) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const { logger } = await import("./log.js");
    use(logger);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { out, err };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("logger", () => {
  it("drops debug by default and keeps info", async () => {
    const { out } = await capture({ PIER_LOG: undefined, JOURNAL_STREAM: undefined }, (logger) => {
      const log = logger("core");
      log.debug("hidden");
      log.info("shown");
    });
    expect(out.join("")).not.toContain("hidden");
    expect(out.join("")).toMatch(/^\S+ INFO {2}core: shown\n$/);
  });

  it("routes warnings and errors to stderr, with the cause's stack", async () => {
    const { out, err } = await capture({ JOURNAL_STREAM: undefined }, (logger) => {
      logger("tasks").error("run failed", new Error("boom"));
    });
    expect(out).toEqual([]);
    expect(err.join("")).toContain("ERROR tasks: run failed: Error: boom");
    expect(err.join("")).toContain("log.test.ts"); // the stack came along
  });

  it("emits journald priority prefixes, and no timestamp, under systemd", async () => {
    const { out, err } = await capture({ JOURNAL_STREAM: "8:1234" }, (logger) => {
      logger("slack").info("started");
      logger("slack").warn("socket lost");
    });
    expect(out).toEqual(["<6>slack: started\n"]);
    expect(err).toEqual(["<4>slack: socket lost\n"]);
  });

  it("prefixes every line, so a stack keeps its level and nothing can forge one", async () => {
    const { err } = await capture({ JOURNAL_STREAM: "8:1234" }, (logger) => {
      logger("client").warn("reported\n<3>auth: not from auth");
    });
    expect(err).toEqual(["<4>client: reported\n<4><3>auth: not from auth\n"]);
  });

  it("PIER_LOG=silent writes nothing at all", async () => {
    const { out, err } = await capture({ PIER_LOG: "silent" }, (logger) => {
      logger("core").error("boom");
    });
    expect([...out, ...err]).toEqual([]);
  });
});
