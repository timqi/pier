// Argv → the exact params object posted, and the answer's two shapes; the
// socket is a recorder, as tasks/cli.test.ts's is for `pier task`.

import { describe, expect, it } from "vitest";
import { runWebCli, type WebCliIo, type WebPost } from "./cli.js";

function rig(answer: { status: number; body: { result?: { text?: string }; error?: string } } = { status: 200, body: { result: { text: "A briefing." } } }) {
  const posted: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: WebCliIo = { stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
  const post: WebPost = async (params) => {
    posted.push(params);
    return answer;
  };
  const run = (...argv: string[]) => runWebCli(argv, post, io);
  return { run, posted, out, err };
}

describe("pier web", () => {
  it("maps both commands onto the server's parameter names and prints the text", async () => {
    const { run, posted, out } = rig();
    expect(await run("search", "阿里巴巴 股价", "--lang", "preserve", "--allow", "a.example, b.example", "--backend", "openai")).toBe(0);
    expect(await run("fetch", "https://x.example/a", "--prompt", "what changed?", "--mode", "thorough")).toBe(0);
    expect(posted).toEqual([
      { op: "search", query: "阿里巴巴 股价", language_mode: "preserve", allowed_domains: ["a.example", "b.example"], blocked_domains: undefined, backend: "openai" },
      { op: "fetch", url: "https://x.example/a", prompt: "what changed?", mode: "thorough" },
    ]);
    expect(out).toEqual(["A briefing.", "A briefing."]);
  });

  it("refuses a wrong shape before the socket, with the command's usage", async () => {
    const { run, posted, err, out } = rig();
    expect(await run("search")).toBe(2);
    expect(await run("search", "a", "b")).toBe(2);
    expect(await run("fetch", "https://x", "--lang", "auto")).toBe(2);
    expect(await run("grep", "x")).toBe(2);
    expect(await run()).toBe(2);
    expect(posted).toEqual([]);
    expect(err[0]).toMatch(/^web: search takes exactly one query\npier web search/);
    expect(err[2]).toMatch(/^web: --lang is not an option of fetch/);
    expect(err[3]).toMatch(/^web: unknown command "grep"/);
    expect(out[0]).toMatch(/^usage: pier web/);
    expect(await run("--help")).toBe(0);
    expect(await run("fetch", "-h")).toBe(0);
  });

  it("prints a refusal as one web: line, exit 1", async () => {
    const { run, err } = rig({ status: 422, body: { error: "No web backend available — anthropic: …" } });
    expect(await run("search", "pier")).toBe(1);
    expect(err).toEqual(["web: No web backend available — anthropic: …"]);
  });
});
