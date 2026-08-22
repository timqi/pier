import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  install,
  limitsPath,
  renderUnit,
  renderUpdateUnit,
  startUpdate,
  uninstall,
  unitPath,
  updateUnitPath,
} from "./service.js";

const home = (): string => mkdtempSync(join(tmpdir(), "pier-home-"));

const options = (over: Partial<Parameters<typeof install>[0]> = {}) => {
  const calls: string[][] = [];
  const said: string[] = [];
  return {
    calls,
    said,
    opts: {
      execPath: "/home/x/.local/share/fnm/node-v24.0.0/bin/node",
      entry: "/home/x/.npm-global/lib/node_modules/@timqi/pier/dist/main.js",
      host: "127.0.0.1",
      port: 3141,
      force: false,
      say: (m: string) => void said.push(m),
      exec: (argv: string[]) => (calls.push(argv), true),
      ...over,
    },
  };
};

describe("renderUnit", () => {
  it("starts the node that installed it, by absolute path", () => {
    const unit = renderUnit({
      execPath: "/opt/node/bin/node",
      entry: "/opt/pier/dist/main.js",
      host: "127.0.0.1",
      port: 3141,
    });
    // The whole reason this is generated: systemd's PATH would not find a
    // version-managed node, and a checkout-relative entry does not exist.
    expect(unit).toContain("ExecStart=/opt/node/bin/node /opt/pier/dist/main.js");
    expect(unit).toContain("Environment=HOST=127.0.0.1");
    expect(unit).toContain("Environment=PORT=3141");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("SyslogIdentifier=pier");
    // Unset means "let Pier use its own default", not "write an empty value".
    expect(unit).not.toContain("PIER_HOME");
  });

  it("carries a PIER_HOME only when one was asked for", () => {
    const unit = renderUnit({
      execPath: "/usr/bin/node",
      entry: "/opt/pier/dist/main.js",
      host: "0.0.0.0",
      port: 8080,
      pierHome: "/srv/pier-state",
    });
    expect(unit).toContain("Environment=PIER_HOME=/srv/pier-state");
    expect(unit).toContain("Environment=HOST=0.0.0.0");
  });
});

describe("install", () => {
  it("writes both files and enables the unit, reload before enable", () => {
    const h = home();
    const { calls, opts } = options({ home: h });
    install(opts);

    expect(readFileSync(unitPath(h), "utf8")).toContain("ExecStart=");
    expect(readFileSync(limitsPath(h), "utf8")).toContain("MemoryMax=75%");
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      `loginctl enable-linger ${userInfo().username}`,
      "systemctl --user enable --now pier.service",
    ]);
  });

  it("refuses to overwrite a unit somebody may have edited", () => {
    const h = home();
    mkdirSync(dirname(unitPath(h)), { recursive: true });
    writeFileSync(unitPath(h), "# mine\n");

    const { calls, said, opts } = options({ home: h });
    install(opts);
    expect(readFileSync(unitPath(h), "utf8")).toBe("# mine\n");
    expect(said.join(" ")).toMatch(/--force/);
    expect(calls).toEqual([]); // nothing was touched, so nothing was reloaded

    install(options({ home: h, force: true }).opts);
    expect(readFileSync(unitPath(h), "utf8")).toContain("ExecStart=");
  });

  it("never rewrites the limits drop-in, which is tuned by hand", () => {
    const h = home();
    install(options({ home: h }).opts);
    writeFileSync(limitsPath(h), "[Service]\nMemoryMax=2G\n");

    install(options({ home: h, force: true }).opts);
    expect(readFileSync(limitsPath(h), "utf8")).toContain("MemoryMax=2G");
  });
});

describe("update", () => {
  it("is a second unit, so restarting Pier cannot kill the update doing it", () => {
    const unit = renderUpdateUnit("/opt/node/bin/node");
    expect(unit).toContain("Type=oneshot");
    // npm from beside that node, not whatever a minimal PATH would find.
    expect(unit).toContain("ExecStart=/opt/node/bin/npm install -g @timqi/pier@latest");
    expect(unit).toContain("ExecStartPost=systemctl --user restart pier.service");
  });

  it("refuses when there is no service to update", () => {
    const h = home();
    const calls: string[][] = [];
    expect(
      startUpdate({ execPath: "/opt/node/bin/node", home: h, say: () => {}, exec: (a) => (calls.push(a), true) }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("writes the unit and starts it detached from the service it restarts", () => {
    const h = home();
    install(options({ home: h }).opts);
    const calls: string[][] = [];
    const said: string[] = [];

    expect(
      startUpdate({
        execPath: "/opt/node/bin/node",
        home: h,
        say: (m) => void said.push(m),
        exec: (a) => (calls.push(a), true),
      }),
    ).toBe(true);
    expect(existsSync(updateUnitPath(h))).toBe(true);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      // --no-block: the unit restarts the service that would be waiting for it.
      "systemctl --user start --no-block pier-update.service",
    ]);
    expect(said.join(" ")).toMatch(/journalctl --user -u pier-update.service/);
  });
});

describe("uninstall", () => {
  it("removes what install wrote and leaves the state alone", () => {
    const h = home();
    install(options({ home: h }).opts);
    const calls: string[][] = [];
    const said: string[] = [];

    uninstall(h, (m) => void said.push(m), (argv) => (calls.push(argv), true));

    expect(existsSync(unitPath(h))).toBe(false);
    expect(existsSync(limitsPath(h))).toBe(false);
    expect(existsSync(updateUnitPath(h))).toBe(false);
    expect(calls[0]).toEqual(["systemctl", "--user", "disable", "--now", "pier.service"]);
    expect(said.join(" ")).toMatch(/PIER_HOME is untouched/);
  });
});
