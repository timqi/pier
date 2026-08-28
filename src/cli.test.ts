import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
