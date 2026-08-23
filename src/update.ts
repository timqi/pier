// Whether a newer Pier exists. Checking, and nothing more.
//
// The registry is asked, not the GitHub API: `registry.npmjs.org` is a CDN with
// no rate limit and no token, and it is the same place `npm i -g` would look,
// so what it reports is what an update would actually get.
//
// Deliberately only an answer. Applying it is `pier update`, a command someone
// types: this process holds provider keys and can run a shell, so a service
// that rewrites its own code on a timer is a supply-chain surface (AGENTS.md 8)
// — and the updater's hard stop would kill whatever turn was mid-flight.

import { createRequire } from "node:module";
import { logger } from "./log.js";

const log = logger("update");

const PACKAGE = "@timqi/pier";
const ENDPOINT = `https://registry.npmjs.org/${PACKAGE}/latest`;
/** Long, because the answer changes on release days and never in between. */
const TTL_MS = 6 * 60 * 60_000;
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
