import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", tsx, cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += String(chunk));
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("pier CLI", () => {
  it("prints the usage instead of starting a server when typed bare", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-cli-bare-"));
    const result = await run([], { env: { ...process.env, HOME: home } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pier serve");
    // Starting one would have printed a first-run password and kept the port.
    expect(result.stdout).not.toMatch(/listening/i);
  });

  it("rejects unknown options instead of silently using defaults", async () => {
    const result = await run(["service", "install", "--porrt", "8080"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown option.*porrt/i);
  });

  it("rejects a port the server cannot listen on", async () => {
    const result = await run(["service", "install", "--port", "NaN"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--port must be an integer from 1 to 65535");
  });

  it("backs up explicitly instead of mutating state while only checking an update", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-cli-backup-"));
    const result = await run(["backup"], { env: { ...process.env, HOME: home } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no database yet");
  });

  it("syncs the managed tools without reaching the network when none are on", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-cli-tools-"));
    const env = { ...process.env, HOME: home, PIER_HOME: join(home, ".pier") };
    const result = await run(["tools", "sync"], { env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no tools switched on");
    // An action nobody implements must not read as one that did nothing.
    expect((await run(["tools"], { env })).code).toBe(2);
    expect((await run(["tools", "list"], { env })).stderr).toMatch(/unknown action "list"/);
  });

  it("returns failure when systemd cannot load the installed unit", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-cli-failure-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    for (const command of ["systemctl", "loginctl"]) {
      const path = join(bin, command);
      writeFileSync(path, "#!/bin/sh\nexit 1\n");
      chmodSync(path, 0o755);
    }

    const result = await run(
      ["service", "install"],
      { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/systemctl --user daemon-reload/);
  });

  it("resolves PIER_HOME and safely writes paths containing spaces", async () => {
    const home = mkdtempSync(join(tmpdir(), "pier-cli-home-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    for (const command of ["systemctl", "loginctl"]) {
      const path = join(bin, command);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }

    const result = await run(
      ["service", "install", "--port", "8080", "--pier-home", "state dir"],
      { cwd: home, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    );
    expect(result.code).toBe(0);
    const unit = readFileSync(join(home, ".config", "systemd", "user", "pier.service"), "utf8");
    expect(unit).toContain(`Environment="PIER_HOME=${resolve(home, "state dir")}"`);
    expect(unit).toContain('Environment="PORT=8080"');
  });
});

describe("pier vault run", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  });

  /** A vault socket answering one scripted response; records what it was asked. */
  async function fakeVault(status: number, body: unknown): Promise<{ home: string; asked: unknown[] }> {
    // Short: a Unix socket path is capped near 108 bytes.
    const home = mkdtempSync(join(tmpdir(), "pv-"));
    const asked: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        asked.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(home, "vault.sock"), done));
    return { home, asked };
  }

  /** A `vt` that prints its arguments and the variable it was asked to swap. */
  function fakeVt(home: string): string {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "vt"), '#!/bin/sh\necho "vt $*"\necho "env $DEPLOY_KEY"\n');
    chmodSync(join(bin, "vt"), 0o755);
    return bin;
  }

  const child = (script: string): string[] => [process.execPath, "-e", script];

  it("puts plain values in the command's env and passes its exit code through", async () => {
    const { home, asked } = await fakeVault(200, {
      values: { SLACK_TOKEN: { kind: "plain", value: "xoxb-1" }, OTHER: { kind: "plain", value: "o" } },
    });
    const result = await run(
      ["vault", "run", "SLACK_BOT_TOKEN=SLACK_TOKEN", "OTHER", "--", ...child(
        'process.stdout.write(process.env.SLACK_BOT_TOKEN + "|" + process.env.OTHER + "|" + process.argv.length); process.exit(3)',
      )],
      { env: { ...process.env, PIER_HOME: home } },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("xoxb-1|o|1");
    expect(result.code).toBe(3);
    expect(asked).toEqual([{
      method: "POST",
      url: "/resolve",
      body: { names: ["SLACK_TOKEN", "OTHER"], pid: expect.any(Number) },
    }]);
  });

  it("wraps the command in vt inject for record values, naming only their variables", async () => {
    const { home } = await fakeVault(200, {
      values: { DEPLOY: { kind: "record", value: "vt://rec" }, PLAIN: { kind: "plain", value: "p" } },
    });
    const bin = fakeVt(home);
    const result = await run(
      ["vault", "run", "DEPLOY_KEY=DEPLOY", "PLAIN", "--", "deploy.sh", "--to", "prod"],
      { env: { ...process.env, PIER_HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("vt inject --only-env DEPLOY_KEY -- deploy.sh --to prod\nenv vt://rec\n");
    expect(result.code).toBe(0);
  });

  it("stops before running anything when a record needs a vt that is not there", async () => {
    const { home } = await fakeVault(200, { values: { DEPLOY: { kind: "record", value: "vt://rec" } } });
    const empty = join(home, "empty");
    mkdirSync(empty);
    const result = await run(
      ["vault", "run", "DEPLOY_KEY=DEPLOY", "--", "deploy.sh"],
      { env: { ...process.env, PIER_HOME: home, PATH: empty } },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("vault: vt is required for DEPLOY (approve level) and was not found\n");
  });

  it("says Pier is not running when there is no socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "pv-"));
    const result = await run(["vault", "run", "A", "--", "true"], { env: { ...process.env, PIER_HOME: home } });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`vault: Pier is not running (no ${join(home, "vault.sock")})\n`);
  });

  it("relays an unknown name with its filing link, and a locked store with its reason", async () => {
    const missing = await fakeVault(404, { error: "no secret named A", file: "https://pier.example/#/settings/vault?name=A" });
    const unknown = await run(["vault", "run", "A", "--", "true"], { env: { ...process.env, PIER_HOME: missing.home } });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toBe("vault: no secret named A — file it at https://pier.example/#/settings/vault?name=A\n");

    const sealed = await fakeVault(423, { error: "locked — unlock() has not run" });
    const locked = await run(["vault", "run", "A", "--", "true"], { env: { ...process.env, PIER_HOME: sealed.home } });
    expect(locked.code).toBe(2);
    expect(locked.stderr).toBe("vault: locked — unlock() has not run\n");
  });

  it("prints the usage for bad syntax, never asking the socket", async () => {
    const { home, asked } = await fakeVault(200, { values: {} });
    const env = { ...process.env, PIER_HOME: home };
    for (const args of [
      ["vault"],
      ["vault", "list"],
      ["vault", "run", "A"],
      ["vault", "run", "--", "true"],
      ["vault", "run", "A", "--"],
      ["vault", "run", "a-b=A", "--", "true"],
      ["vault", "run", "A=B=C", "--", "true"],
    ]) {
      const result = await run(args, { env });
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toBe("usage: pier vault run [ENV=NAME | NAME]... -- <command> [args...]\n");
    }
    expect(asked).toEqual([]);
  });

  it("forwards SIGTERM to the command and exits with its signal status", async () => {
    const { home } = await fakeVault(200, { values: { A: { kind: "plain", value: "a" } } });
    const proc = spawn(process.execPath, [
      "--import", tsx, cli, "vault", "run", "A", "--",
      ...child('process.stdout.write("up"); setTimeout(() => {}, 30_000)'),
    ], { env: { ...process.env, PIER_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done) => proc.stdout.once("data", () => done()));
    proc.kill("SIGTERM");
    const code = await new Promise<number | null>((done) => proc.once("close", done));
    expect(code).toBe(128 + 15);
  });
});
