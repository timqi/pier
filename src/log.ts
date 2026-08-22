// What Pier writes to its own log, and the one place that decides how it looks.
//
// The destination is stdout/stderr and nothing else — no files, no rotation, no
// log configuration. Under systemd that *is* the log: journald stamps the time,
// keeps the history, rotates it and lets `journalctl -p warning` filter it
// (docs/deploy.md), and in a terminal it is the terminal. A logger that opened
// its own file would duplicate all of that and hide half the output from
// `journalctl` — the one place an operator actually looks.
//
// Like paths.ts, this is a leaf everything may import and that imports nothing:
// a log line is not a seam crossing, so no area owns it.

import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

/** `silent` exists for test runs, which drive failure paths on purpose. */
const THRESHOLDS = [...ORDER, "silent"] as const;
type Threshold = (typeof THRESHOLDS)[number];

const isThreshold = (value: string): value is Threshold =>
  (THRESHOLDS as readonly string[]).includes(value);

const RANK: Record<Threshold, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/** `PIER_LOG=debug` turns on the per-message tracing; default keeps it out. */
const raw = (process.env.PIER_LOG ?? "").toLowerCase();
const threshold: Threshold = isThreshold(raw) ? raw : "info";

// systemd sets JOURNAL_STREAM when our output goes to the journal. There the
// time and the level are journal fields, not text: a `<N>` prefix is how a
// plain stream tells journald its priority (sd-daemon(3)), so the same line
// that reads well in a terminal stays greppable *and* filterable by level.
const toJournal = process.env.JOURNAL_STREAM !== undefined;
const PRIORITY: Record<LogLevel, string> = { debug: "<7>", info: "<6>", warn: "<4>", error: "<3>" };

/** `$HOME` back to `~`: a log line is read by a human, and paths dominate.
 *  Skipped when `$HOME` is `/` (containers do this), where it would rewrite
 *  every slash in every message. */
const home = homedir();
const shorten = (text: string): string =>
  home.length > 1 ? text.replaceAll(home, "~") : text;

/** An Error contributes its stack — the post-mortem is why it was logged. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause);

function write(level: LogLevel, area: string, message: string, cause?: unknown): void {
  if (RANK[level] < RANK[threshold]) return;
  const text = shorten(cause === undefined ? message : `${message}: ${describe(cause)}`);
  // Per line, not per message: journald reads a prefix off each line, so a
  // stack's frames would otherwise land at the default priority — and a
  // newline in something a browser reported would let it forge a level.
  const line = toJournal
    ? text.split("\n").map((part, i) => `${PRIORITY[level]}${i === 0 ? `${area}: ` : ""}${part}`).join("\n")
    : `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${area}: ${text}`;
  // Warnings and errors on stderr: it is what journald and every wrapper
  // already treat as the abnormal stream, with or without the prefix above.
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export interface Logger {
  /** Per-message tracing: off unless `PIER_LOG=debug`. */
  debug(message: string, cause?: unknown): void;
  /** A fact worth having after the fact: lifecycle, routing, run outcomes. */
  info(message: string, cause?: unknown): void;
  /** Something was dropped, retried or degraded, and Pier kept serving. */
  warn(message: string, cause?: unknown): void;
  /** Someone lost something: a turn, a delivery, a connection. */
  error(message: string, cause?: unknown): void;
}

/** `logger("slack")` — the area is the grep handle, so keep it stable. */
export const logger = (area: string): Logger => ({
  debug: (message, cause) => write("debug", area, message, cause),
  info: (message, cause) => write("info", area, message, cause),
  warn: (message, cause) => write("warn", area, message, cause),
  error: (message, cause) => write("error", area, message, cause),
});
