// The newer Pier: whether one exists, and when this one may become it.
//
// The registry is asked, not the GitHub API: `registry.npmjs.org` is a CDN with
// no rate limit and no token, and it is the same place `npm i -g` would look,
// so what it reports is what an update would actually get.
//
// Nothing here installs anything. Applying is handed to whatever supervises
// this process (service.ts's oneshot unit, injected as `apply`): a web server
// holding provider keys must not npm-install as its own child, and the two
// gates below — the operator switched it on, and nothing is running — are why
// a self-replacing timer is not simply a supply-chain surface (AGENTS.md 8).

import { createRequire } from "node:module";
import { logger } from "./log.js";

const log = logger("update");

const PACKAGE = "@timqi/pier";
const ENDPOINT = `https://registry.npmjs.org/${PACKAGE}/latest`;
/** One conditional-GET-sized request against a CDN, so the cost of asking is
 *  not what sets this — how long a released fix may sit unnoticed is. */
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

/**
 * `1.2.3` against `1.10.0`, numerically per field: a string compare would call
 * the second one older. A prerelease suffix loses to the release it precedes,
 * which is all the semver this needs.
 */
export function isNewer(candidate: string, than: string): boolean {
  const parse = (v: string): number[] =>
    (v.split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(than)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  // Equal numbers: a prerelease is older than the release of the same version.
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

  /** The last answer, and a refresh in the background when it is stale. Never
   *  awaits the network: a workbench that loads is worth more than a fresh
   *  version number. */
  status(): UpdateStatus {
    if (this.now() - this.#checkedAt >= TTL_MS) void this.refresh();
    return {
      current: this.current,
      latest: this.#latest,
      available: this.#latest !== null && isNewer(this.#latest, this.current),
    };
  }

  /** The answer, waiting for the very first check instead of reporting "no
   *  idea". A browser asks once per page load, so a process that had never
   *  checked told every one of them `latest: null` — which is exactly how a
   *  published release looked undetected. Later loads are served from cache. */
  async statusNow(): Promise<UpdateStatus> {
    if (this.#checkedAt === 0) await this.refresh();
    return this.status();
  }

  /** Ask now. Concurrent callers share the one request. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.fetchLatest()
      .then((latest) => {
        this.#latest = latest;
        if (isNewer(latest, this.current)) log.info(`${latest} is available (running ${this.current})`);
      })
      // A failed check is not a failure: no network, an offline box, a registry
      // hiccup. It is reported once at debug and retried at the next TTL.
      .catch((err) => log.debug(`registry check failed: ${String(err)}`))
      .finally(() => {
        this.#checkedAt = this.now();
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }
}

/** `busy`: another handover or a restart already owns the gate — not a
 *  failure, just not this caller's turn. */
export type UpdateStart = "started" | "busy" | "not-installed" | "failed";

/** How this instance replaces itself, and when it is allowed to. */
export interface AutoUpdate {
  /** The operator's switch (Console → the version badge). */
  enabled: () => boolean;
  /** No turn streaming and no task run in flight — the updater stops the
   *  service, so anything running when it fires is work thrown away. */
  idle: () => boolean;
  /** Close the door, then hand the install over. Async because closing it
   *  properly means draining, and a drain waits: `idle()` is a snapshot, and a
   *  message that arrived just after it must be refused rather than killed
   *  mid-turn by the updater's SIGTERM (main.ts owns that half). "started"
   *  means this process is about to be stopped by something that is not it. */
  apply: () => Promise<UpdateStart>;
}

/** Often enough to catch an idle window on a busy box, and cheap: the registry
 *  itself is still only asked once per TTL (`status()` owns that). */
const AUTO_POLL_MS = 15 * 60_000;

/** Watch for the moment all three conditions hold. Returns its own stop. */
export function startAutoUpdate(
  check: UpdateCheck,
  auto: AutoUpdate,
  pollMs = AUTO_POLL_MS,
): () => void {
  // A handover drains first, which can outlast a poll interval; a second
  // attempt on top of it would drain an already-draining Pier.
  let handingOver = false;
  const tick = async (): Promise<void> => {
    if (handingOver || !auto.enabled()) return;
    // Refreshes in the background when stale; today's answer is good enough,
    // because the next tick is a quarter of an hour away either way.
    const { latest, available } = check.status();
    if (!available || !auto.idle()) return;
    log.info(`auto-update: idle and ${latest ?? "a newer version"} is out — handing over to the updater`);
    handingOver = true;
    try {
      const started = await auto.apply();
      // Not silent (§5b): an update that never happens must not look like an
      // update that was never wanted. `busy` is the one non-start that is
      // fine — someone else is already restarting this Pier.
      if (started === "busy") log.info("auto-update: a handover or restart is already in progress");
      else if (started !== "started") log.error(`auto-update could not start: ${started}`);
    } catch (err) {
      log.error("auto-update failed", err);
    } finally {
      // Only reached when the handover did *not* take the process with it, so
      // the next tick is allowed to try again.
      handingOver = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref(); // a pending check must never be what keeps the process alive
  return () => clearInterval(timer);
}

export async function fetchLatestVersion(): Promise<string> {
  // Plain JSON: the abbreviated-packument content type npm uses for a whole
  // package is a 406 on this endpoint, which answers one version already.
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
