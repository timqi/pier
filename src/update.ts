// The newer Pier: whether one exists, and when this one may become it. The npm
// registry is asked (no rate limit, and what `npm i -g` would get). Nothing
// here installs: a web server holding provider keys must not npm-install as its
// own child, so applying is handed to the supervisor (service.ts).

import { createRequire } from "node:module";
import { logger } from "./log.js";

const log = logger("update");

const PACKAGE = "@timqi/pier";
const ENDPOINT = `https://registry.npmjs.org/${PACKAGE}/latest`;
/** Set by how long a released fix may sit unnoticed, not by request cost. */
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 5_000;

export const currentVersion = (): string =>
  (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface UpdateStatus {
  current: string;
  /** `null` when the registry has not answered yet, or could not be reached. */
  latest: string | null;
  /** Only true when a real comparison says so — never when `latest` is null. */
  available: boolean;
}

export const isValidVersion = (version: string): boolean =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);

/** Numeric per field (a string compare calls `1.10.0` older than `1.2.3`); a
 *  prerelease loses to its release, which is all the semver this needs. */
export function isNewer(candidate: string, than: string): boolean {
  const parse = (v: string): number[] =>
    (v.split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(than)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  const pre = (v: string): string => v.split("-")[1] ?? "";
  return pre(candidate) === "" && pre(than) !== "";
}

/** One registry answer, cached, shared by every caller. */
export class UpdateCheck {
  #latest: string | null = null;
  #checkedAt = 0;
  #inFlight: Promise<void> | undefined;

  constructor(
    private readonly current = currentVersion(),
    private readonly fetchLatest: () => Promise<string> = fetchLatestVersion,
    private readonly now: () => number = Date.now,
  ) {}

  /** Never awaits the network: a workbench that loads is worth more than a
   *  fresh version number. */
  status(): UpdateStatus {
    if (this.now() - this.#checkedAt >= TTL_MS) void this.refresh();
    return {
      current: this.current,
      latest: this.#latest,
      available: this.#latest !== null && isNewer(this.#latest, this.current),
    };
  }

  /** Waits for the very first check: `latest: null` on every page load is how
   *  a published release goes undetected. */
  async statusNow(): Promise<UpdateStatus> {
    if (this.#checkedAt === 0) await this.refresh();
    return this.status();
  }

  /** Concurrent callers share the one request. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.fetchLatest()
      .then((latest) => {
        this.#latest = latest;
        if (isNewer(latest, this.current)) log.info(`${latest} is available (running ${this.current})`);
      })
      // No network or a registry hiccup is not a failure; retried at the next TTL.
      .catch((err) => log.debug(`registry check failed: ${String(err)}`))
      .finally(() => {
        this.#checkedAt = this.now();
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }
}

/** `busy`: another handover or a restart already owns the gate. */
export type UpdateStart = "started" | "busy" | "not-installed" | "failed";

/** How this instance replaces itself, and when it is allowed to. */
export interface AutoUpdate {
  enabled: () => boolean;
  /** The updater stops the service, so anything running when it fires is thrown away. */
  idle: () => boolean;
  /** Drains first: `idle()` is a snapshot, and a message that arrived just
   *  after it must be refused, not killed mid-turn by the updater's SIGTERM. */
  apply: () => Promise<UpdateStart>;
}

/** Often enough to catch an idle window on a busy box; the registry is still
 *  asked only once per TTL. */
const AUTO_POLL_MS = 15 * 60_000;

/** Watch for the moment all three conditions hold. Returns its own stop. */
export function startAutoUpdate(
  check: UpdateCheck,
  auto: AutoUpdate,
  pollMs = AUTO_POLL_MS,
): () => void {
  // A drain can outlast a poll interval.
  let handingOver = false;
  const tick = async (): Promise<void> => {
    if (handingOver || !auto.enabled()) return;
    const { latest, available } = check.status();
    if (!available || !auto.idle()) return;
    log.info(`auto-update: idle and ${latest ?? "a newer version"} is out — handing over to the updater`);
    handingOver = true;
    try {
      const started = await auto.apply();
      // §5: an update that never happens must not look like one never wanted.
      if (started === "busy") log.info("auto-update: a handover or restart is already in progress");
      else if (started !== "started") log.error(`auto-update could not start: ${started}`);
    } catch (err) {
      log.error("auto-update failed", err);
    } finally {
      // Only reached when the handover did not take the process with it.
      handingOver = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function fetchLatestVersion(): Promise<string> {
  // npm's abbreviated-packument content type is a 406 on this endpoint.
  const res = await fetch(ENDPOINT, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !isValidVersion(body.version)) {
    throw new Error("registry answered without a valid version");
  }
  return body.version;
}
