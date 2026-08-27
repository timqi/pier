// Which repository a project directory belongs to, and which branch it has
// checked out.
//
// One reason: worktrees. A parallel-work checkout is a sibling directory with
// the same repository behind it, so the rail drew one project per directory and
// a repo worked on three branches looked like three unrelated projects. The
// grouping fact is not the path — `<repo>.<branch>` is a naming convention
// nobody is obliged to follow — it is the common git dir every worktree of a
// repository shares, and git is the only thing that knows it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../log.js";

const run = promisify(execFile);
const log = logger("web");

/** How long an answer stands. Repository identity never moves; the branch does,
 *  and a checkout switched under a session should say so within a minute. */
const TTL_MS = 60_000;

/** A probe that hangs must not hold a slot forever: this is a `rev-parse`. */
const TIMEOUT_MS = 5_000;

export interface RepoInfo {
  /** The common git dir every worktree of this repository shares — a grouping
   *  key, not a path anything opens. */
  repo: string;
  /** The checked-out branch, absent when the head is detached. */
  branch?: string;
}

/** One `rev-parse` for both facts. `--path-format=absolute` applies to the
 *  path option that follows it, so the two answers come back in argument
 *  order: common dir, then branch. */
const probeGit = async (cwd: string): Promise<RepoInfo | null> => {
  const { stdout } = await run(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"],
    { timeout: TIMEOUT_MS },
  );
  const [repo, branch] = stdout.split("\n").map((line) => line.trim());
  if (!repo) return null;
  return { repo, ...(branch && branch !== "HEAD" ? { branch } : {}) };
};

export class RepoIndex {
  #cache = new Map<string, { at: number; info: RepoInfo | null }>();
  #probing = new Set<string>();

  constructor(
    /** Called when a probe changed what `get` answers, so the surface that
     *  already rendered the old grouping is told to ask again. */
    private readonly onChange: () => void = () => {},
    private readonly probe: (cwd: string) => Promise<RepoInfo | null> = probeGit,
  ) {}

  /**
   * What is known right now, and never a promise: the rail renders on the first
   * paint, with one project per directory until the answer lands and `onChange`
   * regroups it. A directory that is not a repository answers `undefined`
   * forever, at the cost of one `rev-parse` a minute.
   */
  get(cwd: string): RepoInfo | undefined {
    const hit = this.#cache.get(cwd);
    if (!hit || Date.now() - hit.at > TTL_MS) void this.#refresh(cwd);
    return hit?.info ?? undefined;
  }

  async #refresh(cwd: string): Promise<void> {
    if (this.#probing.has(cwd)) return;
    this.#probing.add(cwd);
    try {
      const info = await this.probe(cwd).catch(() => null);
      const before = this.#cache.get(cwd)?.info;
      this.#cache.set(cwd, { at: Date.now(), info });
      if (before?.repo !== info?.repo || before?.branch !== info?.branch) this.onChange();
    } catch (err) {
      // Not a git failure — those are the `null` above. Something in the probe
      // itself, which would otherwise leave the directory retried every read.
      log.warn(`repository probe for ${cwd} failed`, err);
      this.#cache.set(cwd, { at: Date.now(), info: null });
    } finally {
      this.#probing.delete(cwd);
    }
  }
}
