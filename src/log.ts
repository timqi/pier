// What Pier writes to its own log. stdout/stderr only: under systemd journald
// is the log (timestamps, history, rotation, `journalctl -p warning`), and a
// file of our own would hide half the output from it.

import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

/** `silent` exists for test runs, which drive failure paths on purpose. */
const THRESHOLDS = [...ORDER, "silent"] as const;
type Threshold = (typeof THRESHOLDS)[number];

const isThreshold = (value: string): value is Threshold =>
  (THRESHOLDS as readonly string[]).includes(value);

const RANK: Record<Threshold, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

const raw = (process.env.PIER_LOG ?? "").toLowerCase();
const threshold: Threshold = isThreshold(raw) ? raw : "info";

// systemd sets JOURNAL_STREAM when output goes to the journal; a `<N>` prefix
// is how a plain stream tells journald its priority (sd-daemon(3)).
const toJournal = process.env.JOURNAL_STREAM !== undefined;
const PRIORITY: Record<LogLevel, string> = { debug: "<7>", info: "<6>", warn: "<4>", error: "<3>" };

/** Skipped when `$HOME` is `/` (containers), where it would rewrite every slash. */
const home = homedir();
const shorten = (text: string): string =>
  home.length > 1 ? text.replaceAll(home, "~") : text;

const describe = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause);

function write(level: LogLevel, area: string, message: string, cause?: unknown): void {
  if (RANK[level] < RANK[threshold]) return;
  const text = shorten(cause === undefined ? message : `${message}: ${describe(cause)}`);
  // Per line: journald reads a prefix off each line, and a newline in
  // something a browser reported would otherwise let it forge a level.
  const line = toJournal
    ? text.split("\n").map((part, i) => `${PRIORITY[level]}${i === 0 ? `${area}: ` : ""}${part}`).join("\n")
    : `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${area}: ${text}`;
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

/** The area is the grep handle, so keep it stable. */
export const logger = (area: string): Logger => ({
  debug: (message, cause) => write("debug", area, message, cause),
  info: (message, cause) => write("info", area, message, cause),
  warn: (message, cause) => write("warn", area, message, cause),
  error: (message, cause) => write("error", area, message, cause),
});
