// `pier web search|fetch …`: argv → the params object `/web` takes. Argv shape
// is the only thing checked here; the server validates the fields, and its
// text comes back verbatim.

import { parseArgs } from "node:util";

export interface WebCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** `POST /web` as cli.ts performs it; the socket's own refusals never return. */
export type WebPost = (params: Record<string, unknown>) => Promise<{ status: number; body: { result?: { text?: string }; error?: string } }>;

const OPTIONS = {
  lang: { type: "string" }, allow: { type: "string" }, block: { type: "string" }, backend: { type: "string" },
  prompt: { type: "string" }, mode: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;
type Flag = keyof typeof OPTIONS;
type Values = Partial<Record<Flag, string | boolean>>;

/** The usage line is the contract (skills/pier-web/SKILL.md); the flags a
 *  command accepts are read off it, so the two cannot drift. */
const COMMANDS: Record<string, { usage: string; help: string }> = {
  search: {
    usage: "search <query> [--lang auto|preserve|expand] [--allow <domain,…> | --block <domain,…>] [--backend anthropic|openai]",
    help: "a briefing with sources from the provider's hosted search; --lang preserve never translates the query",
  },
  fetch: {
    usage: "fetch <url> [--prompt <question>] [--mode concise|thorough|full]",
    help: "a page or PDF as a digest (concise), a detailed one (thorough), or whole (full); the full copy is always saved to disk",
  },
};

const USAGE = [
  "usage: pier web <command> … — the public web through the provider's hosted tools (skills/pier-web)",
  ...Object.values(COMMANDS).map(({ usage, help }) => `  ${usage}\n      ${help}`),
  "The answer is text, exit 0; a refusal is one `web:` line, exit 1.",
].join("\n");

const processIo: WebCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const list = (raw: string | boolean | undefined): string[] | undefined =>
  raw === undefined ? undefined : String(raw).split(",").map((d) => d.trim()).filter(Boolean);

export async function runWebCli(argv: string[], post: WebPost, io: WebCliIo = processIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 2;
  }
  const cmd = COMMANDS[name];
  const usage = (message: string): number => {
    io.stderr(`web: ${message}\n${cmd ? `pier web ${cmd.usage}` : USAGE}`);
    return 2;
  };
  if (!cmd) return usage(`unknown command "${name}"`);
  const allowed = new Set((cmd.usage.match(/--[a-z-]+/g) ?? []).map((flag) => flag.slice(2)));
  let params: Record<string, unknown>;
  try {
    const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    const v = values as Values;
    if (v.help) {
      io.stdout(`pier web ${cmd.usage}\n    ${cmd.help}`);
      return 0;
    }
    const stray = (Object.keys(v) as Flag[]).find((flag) => !allowed.has(flag));
    if (stray) return usage(`--${stray} is not an option of ${name}`);
    if (positionals.length !== 1) return usage(`${name} takes exactly one ${name === "search" ? "query" : "url"}`);
    params = name === "search"
      ? { op: "search", query: positionals[0], language_mode: v.lang, allowed_domains: list(v.allow), blocked_domains: list(v.block), backend: v.backend }
      : { op: "fetch", url: positionals[0], prompt: v.prompt, mode: v.mode };
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  const { status, body } = await post(params);
  if (status === 200 && body.result?.text !== undefined) {
    io.stdout(body.result.text);
    return 0;
  }
  io.stderr(`web: ${body.error ?? `socket answered ${String(status)}`}`);
  return 1;
}
