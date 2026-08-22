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
  updateRuntimePath,
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
      npmPath: "/home/x/.npm-global/bin/npm",
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
      npmPath: "/opt/node/bin/npm",
      entry: "/opt/pier/dist/main.js",
      host: "127.0.0.1",
      port: 3141,
    });
    // The whole reason this is generated: systemd's PATH would not find a
    // version-managed node, and a checkout-relative entry does not exist.
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/pier/dist/main.js"');
    expect(unit).toContain('Environment="HOST=127.0.0.1"');
    expect(unit).toContain('Environment="PORT=3141"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("SyslogIdentifier=pier");
    // Unset means "let Pier use its own default", not "write an empty value".
    expect(unit).not.toContain("PIER_HOME");
  });

  it("carries a PIER_HOME only when one was asked for", () => {
    const unit = renderUnit({
      execPath: "/usr/bin/node",
      npmPath: "/usr/bin/npm",
      entry: "/opt/pier/dist/main.js",
      host: "0.0.0.0",
      port: 8080,
      pierHome: "/srv/pier-state",
    });
    expect(unit).toContain('Environment="PIER_HOME=/srv/pier-state"');
    expect(unit).toContain('Environment="HOST=0.0.0.0"');
  });

  it("quotes spaces and escapes systemd expansion in paths", () => {
    const unit = renderUnit({
      execPath: "/opt/Node $Runtime/%v/bin/node",
      npmPath: "/opt/Npm $Runtime/%v/bin/npm",
      entry: "/opt/Pier App/dist/main.js",
      host: "::1",
      port: 3141,
      pierHome: "/srv/Pier State/%i/$data",
    });
    expect(unit).toContain('ExecStart="/opt/Node $$Runtime/%%v/bin/node" "/opt/Pier App/dist/main.js"');
    expect(unit).toContain('Environment="PIER_HOME=/srv/Pier State/%%i/$data"');
  });
});

describe("install", () => {
  it("writes both files and enables the unit, reload before enable", () => {
    const h = home();
    const { calls, opts } = options({ home: h });
    install(opts);

    expect(readFileSync(unitPath(h), "utf8")).toContain("ExecStart=");
    expect(readFileSync(updateUnitPath(h), "utf8")).toContain("@timqi/pier@latest");
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

  it("restarts an existing service when --force replaces its settings", () => {
    const h = home();
    mkdirSync(dirname(unitPath(h)), { recursive: true });
    writeFileSync(unitPath(h), "# old\n");
    const { calls, opts } = options({ home: h, force: true });
    expect(install(opts)).toBe(true);
    expect(calls.slice(-2)).toEqual([
      ["systemctl", "--user", "enable", "pier.service"],
      ["systemctl", "--user", "restart", "pier.service"],
    ]);
  });

  it("returns failure and stops when daemon-reload fails", () => {
    const h = home();
    const calls: string[][] = [];
    expect(install(options({ home: h, exec: (argv) => (calls.push(argv), false) }).opts)).toBe(false);
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });
});

describe("update", () => {
  it("stops, backs up, updates the recorded npm installation, and always starts again", () => {
    const unit = renderUpdateUnit({
      execPath: "/opt/node/bin/node",
      npmPath: "/opt/npm-global/bin/npm",
      entry: "/opt/npm-global/lib/node_modules/@timqi/pier/dist/main.js",
      host: "127.0.0.1",
      port: 3141,
    });
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("ExecStart=systemctl --user stop pier.service");
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/npm-global/lib/node_modules/@timqi/pier/dist/cli.js" backup');
    // npm under the recorded node: its shebang cannot resolve on systemd's PATH.
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/npm-global/bin/npm" install -g @timqi/pier@latest');
    expect(unit).toContain("ExecStopPost=systemctl --user start pier.service");
    expect(unit).not.toContain("refresh");
  });

  it("refuses when there is no service to update", () => {
    const h = home();
    const calls: string[][] = [];
    expect(startUpdate({ home: h, say: () => {}, exec: (a) => (calls.push(a), true) }))
      .toBe("not-installed");
    expect(calls).toEqual([]);
  });

  it("uses recorded npm and the running service's effective PIER_HOME", () => {
    const h = home();
    install(options({ home: h }).opts);
    const calls: string[][] = [];
    const said: string[] = [];

    expect(startUpdate({
      home: h,
      say: (m) => void said.push(m),
      exec: (a) => (calls.push(a), true),
      effectiveHome: () => "/effective/Pier State/%literal",
    })).toBe("started");
    expect(readFileSync(updateUnitPath(h), "utf8"))
      .toContain('ExecStart="/home/x/.local/share/fnm/node-v24.0.0/bin/node" "/home/x/.npm-global/bin/npm"');
    expect(readFileSync(updateRuntimePath(h), "utf8"))
      .toContain('Environment="PIER_HOME=/effective/Pier State/%%literal"');
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user start --no-block pier-update.service",
    ]);
    expect(said.join(" ")).toMatch(/pier.db.release.bak/);
  });

  it("bridges a legacy unit once, naming its npm-path limitation", () => {
    const h = home();
    mkdirSync(dirname(unitPath(h)), { recursive: true });
    writeFileSync(unitPath(h), [
      "ExecStart=/old/node/bin/node /old/node/lib/node_modules/@timqi/pier/dist/main.js",
      "Environment=HOST=127.0.0.1",
      "Environment=PORT=3141",
      "",
    ].join("\n"));
    const said: string[] = [];

    expect(startUpdate({
      home: h,
      say: (m) => void said.push(m),
      exec: () => true,
      effectiveHome: () => "/srv/pier",
    })).toBe("started");
    expect(readFileSync(updateUnitPath(h), "utf8"))
      .toContain('ExecStart="/old/node/bin/node" "/old/node/bin/npm" install -g @timqi/pier@latest');
    expect(said.join(" ")).toMatch(/legacy updater.*exact npm path/);
  });

  it("refuses when effective state cannot be read or systemd cannot start", () => {
    const h = home();
    install(options({ home: h }).opts);
    expect(startUpdate({ home: h, say: () => {}, exec: () => true, effectiveHome: () => { throw new Error("stopped"); } }))
      .toBe("failed");
    expect(startUpdate({ home: h, say: () => {}, exec: () => false, effectiveHome: () => "/srv/pier" }))
      .toBe("failed");

    let calls = 0;
    expect(startUpdate({
      home: h,
      say: () => {},
      exec: () => ++calls === 1,
      effectiveHome: () => "/srv/pier",
    })).toBe("failed");
    expect(calls).toBe(2);
  });
});

describe("uninstall", () => {
  it("does not remove the unit when stopping it fails", () => {
    const h = home();
    install(options({ home: h }).opts);
    expect(uninstall(h, () => {}, () => false)).toBe(false);
    expect(existsSync(unitPath(h))).toBe(true);
  });

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
