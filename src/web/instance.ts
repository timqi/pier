// Routes about the Pier instance itself — settings, update availability,
// layer-1 secrets control, the browser's error reports. Nothing here touches
// a session; server.ts stays the session/event surface.

import type { Hono } from "hono";
import type { CatalogBinary, CatalogEntry } from "../core/types.js";
import { logger } from "../log.js";
import type { SecretsMode } from "../secrets.js";
import {
  normalizeModelMenu,
  normalizePublicUrl,
  normalizeTerminalInitCommand,
  type SettingsStore,
} from "../settings.js";
// Type-only, and only for the shape the injected validator answers with:
// erased at build, so web/ still runs nothing from tools.ts (architecture.md).
import type { CustomTool } from "../tools.js";
import type { ToolsSyncNote } from "./types.js";
import type { UpdateCheck } from "../update.js";

/** How this instance replaces itself, or `null` where nothing supervises it.
 *  Injected so web/ never learns what systemd is — and so the install never
 *  runs as a child of the request that asked for it. */
export interface UpdateApplier {
  /** `busy`: another handover or a restart already owns the gate. */
  apply(): Promise<"started" | "busy" | "not-installed" | "failed">;
  /** Why applying would fail today, checked before it is attempted. A stale
   *  updater is invisible until the update that needed it (§5b). */
  problem(): string | null;
}

/** The slice of Secrets the routes need; injectable so tests never touch disk
 *  or spawn vt. Never exposes key material — state, mode and the locked reason
 *  are all a browser may see. */
export interface SecretsControl {
  readonly state: "locked" | "unlocked";
  readonly mode: SecretsMode | undefined;
  readonly lockedReason: string;
  unlock(): Promise<void>;
  rotateKek(mode?: SecretsMode): Promise<void>;
}

/** A rule that failed inside the transaction — its own class so the route can
 *  tell it from a real fault. 400 when the request named something this Pier
 *  does not have, 409 when it collided with the state as it stands. */
class Refusal extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

/** One name added to or removed from a stored set, order preserved. */
const withName = (current: readonly string[], { name, on }: { name: string; on: boolean }): string[] =>
  on ? [...new Set([...current, name])] : current.filter((each) => each !== name);

/** Client reports per minute, for the whole server: a browser bug can fire in
 *  a loop, and the journal is shared with everything else Pier says. */
const CLIENT_LOG_PER_MINUTE = 60;

export function registerInstanceRoutes(
  app: Hono,
  deps: {
    settings: SettingsStore;
    /** Whether a newer Pier exists; answered from cache, refreshed in the
     *  background. */
    updates: UpdateCheck;
    /** `null` when no service manager owns this process: the Console then says
     *  so instead of offering a button that cannot work. */
    updater?: UpdateApplier | null;
    secrets: SecretsControl;
    /** Everything with a switch — bundled extensions and managed binaries in
     *  one list — plus the task whose runs install the binaries. Handed over
     *  as data by main.ts: the catalog is code that imports the Pi SDK and
     *  spawns ubix, and web/ may do neither. Absent in tests that do not care;
     *  the Console then shows no switches. */
    catalog?: () => Promise<{ entries: CatalogEntry[]; toolsTaskId: string | null }>;
    /** Every name this Pier can ever switch: the bundled extensions and the
     *  tools it manages. Code, not state — which is why a switch is validated
     *  against these and not against the catalog, whose custom half the same
     *  request may be rewriting. Absent means no switches, and every `on` is
     *  refused. */
    names?: { extensions: readonly string[]; tools: readonly string[] };
    /** Ran after the tool set was written. Answers with what became of the
     *  install — started, waiting behind a sync already running, or refused
     *  with a reason — because the switch that was just flipped is where that
     *  belongs, not only the journal (§5b). It reads the stored set itself:
     *  passing it in would be a second copy of what was just written. */
    onToolsChanged?: () => Promise<ToolsSyncNote | null>;
    /** What a custom tool may be. Injected because the rule lives with the
     *  installer (src/tools.ts) and web/ may not import it; main.ts also folds
     *  in the names the bundled catalog already owns. */
    validateCustomTools?: (raw: unknown) => { tools: CustomTool[] } | { error: string };
    /** Ran after a successful unlock; main.ts starts the channels it held
     *  back. A callback because web/ must not import channels/. */
    onUnlocked?: () => void;
    /** The public URL rides in the prompt a session is opened with, so a live
     *  session still quotes the old one: server.ts recycles the idle ones. */
    onSettingsChanged?: () => void;
  },
): void {
  const {
    settings,
    updates,
    updater = null,
    secrets,
    catalog,
    names = { extensions: [], tools: [] },
    onUnlocked,
    onSettingsChanged,
    onToolsChanged,
    validateCustomTools,
  } = deps;
  const updateLog = logger("update");
  // How long POST /api/update may hold its response open. A busy Pier drains
  // first, which can take minutes, and a response held that long dies at every
  // proxy on the way (principle 7): past this cap the answer is "draining".
  const APPLY_REPLY_CAP_MS = 10_000;

  // The browser's half of the log. A workbench that threw after the response
  // left the server is otherwise invisible here (ui/report.ts) — this is the
  // one route whose entire purpose is to make it visible.
  const clientLog = logger("client");
  let reports: number[] = [];
  app.post("/api/client-log", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      message?: unknown;
      stack?: unknown;
      view?: unknown;
    } | null;
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message required" }, 400);
    }
    const now = Date.now();
    reports = reports.filter((at) => now - at < 60_000);
    if (reports.length >= CLIENT_LOG_PER_MINUTE) return c.body(null, 429);
    reports.push(now);
    const cap = (value: unknown, max: number): string =>
      typeof value === "string" ? value.slice(0, max) : "";
    const where = cap(body.view, 120);
    const stack = cap(body.stack, 2000);
    // One line, ua included: "only on iOS" is the answer half these questions
    // have, and the report is the only place it exists.
    clientLog.warn(
      `${cap(body.message, 500)} [${where || "/"}] ${cap(c.req.header("user-agent"), 160)}` +
        (stack ? `\n${stack}` : ""),
    );
    return c.body(null, 204);
  });

  // Instance settings. The password lives behind its own route (web/auth.ts):
  // it is a credential, and changing it takes the old one.
  // The catalog rides along: one round trip for the whole page, and the
  // switches cannot disagree with the setting they are drawn from. One shape
  // for both the read and the write, or the page reconciles two answers.
  const instanceSettings = async () => {
    const shown = await catalog?.();
    return {
      ...settings.get(),
      catalog: shown?.entries ?? [],
      /** Where the runs are: the install and every daily update is one task's
       *  history, not a second status surface this route invented. */
      toolsTaskId: shown?.toolsTaskId ?? null,
    };
  };

  app.get("/api/settings", async (c) => c.json(await instanceSettings()));

  // What the version badge reads: the two versions, whether this instance can
  // do anything about the gap, and whether it is allowed to do it unattended.
  // `statusNow` so a browser opened seconds after a restart is told the truth
  // rather than "no idea yet".
  app.get("/api/update", async (c) =>
    c.json({
      ...(await updates.statusNow()),
      canApply: updater !== null,
      autoUpdate: settings.get().autoUpdate,
      // Reported whether or not an update is pending: the repair is the same,
      // and finding out at the next restart is finding out too late.
      problem: updater?.problem() ?? null,
    }));

  // Applying. Nothing is installed here: the work is handed to the service
  // manager's own oneshot unit, which stops Pier, backs the database up,
  // installs and starts Pier again — an npm child of this process would be
  // killed by the very restart it is performing.
  app.post("/api/update", async (c) => {
    if (!updater) {
      return c.json({ error: "no service manager owns this Pier — update it with: pier update" }, 409);
    }
    const { current, latest, available } = await updates.statusNow();
    if (!available) {
      return c.json({ error: latest === null ? "the registry could not be reached" : `${current} is the latest` }, 409);
    }
    const problem = updater.problem();
    if (problem !== null) {
      updateLog.error(`update to ${latest} refused: ${problem}`);
      return c.json({ error: problem }, 409);
    }
    const applied = updater.apply().catch((err: unknown): "failed" => {
      updateLog.error("update handover failed", err);
      return "failed";
    });
    const started = await Promise.race([
      applied,
      new Promise<"draining">((resolve) => setTimeout(resolve, APPLY_REPLY_CAP_MS, "draining").unref()),
    ]);
    if (started === "draining") {
      // The handover keeps running behind this response; if it fails later,
      // main.ts's takeWorkAgain reports it and reopens the gate (§5b).
      updateLog.info(`updating to ${latest} on the Console's request — waiting for running work to finish`);
      return c.json({ started: true, draining: true, latest }, 202);
    }
    if (started === "busy") {
      return c.json({ error: "an update or restart is already in progress" }, 409);
    }
    if (started !== "started") {
      updateLog.error(`update to ${latest} refused by the updater: ${started}`);
      return c.json({
        error: started === "not-installed"
          ? "the systemd unit is not installed — run: pier service install"
          : "the updater could not be started; see the journal",
      }, 500);
    }
    updateLog.info(`updating to ${latest} on the Console's request — Pier stops and starts again`);
    return c.json({ started: true, latest });
  });

  // Partial on purpose: each surface sends only the setting it edits, and a
  // malformed field is rejected before anything is written.
  //
  // A switch sends a *delta* (`tool`/`extension`), not the list it computed:
  // two quick clicks each carry a list built from what the page knew a moment
  // ago, so the second silently drops the first.
  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | {
        publicUrl?: unknown;
        modelMenu?: unknown;
        autoUpdate?: unknown;
        terminalInitCommand?: unknown;
        customTools?: unknown;
        extension?: unknown;
        tool?: unknown;
      }
      | null;
    const fields = body
      ? [body.publicUrl, body.modelMenu, body.autoUpdate, body.terminalInitCommand, body.customTools, body.extension, body.tool]
      : [];
    if (!fields.some((v) => v !== undefined)) {
      return c.json({
        error: "publicUrl, modelMenu, autoUpdate, terminalInitCommand, customTools, extension or tool required",
      }, 400);
    }
    // Everything is validated before anything is written, and everything is
    // written in one transaction: a request carrying a new custom tool *and*
    // the switch that turns it on must not leave one of the two stored.
    const writes: (() => void)[] = [];
    const refuse = (error: string) => c.json({ error }, 400);
    if (body?.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") return refuse("publicUrl must be a string");
      const publicUrl = normalizePublicUrl(body.publicUrl);
      if (publicUrl === null) return refuse("not a URL: expected http(s)://host, no query or fragment");
      writes.push(() => settings.setPublicUrl(publicUrl));
    }
    if (body?.modelMenu !== undefined) {
      const menu = normalizeModelMenu(body.modelMenu);
      if (menu === null) return refuse("modelMenu must be [{provider, id, note?}] (≤32 entries)");
      writes.push(() => settings.setModelMenu(menu));
    }
    if (body?.autoUpdate !== undefined) {
      const { autoUpdate } = body;
      if (typeof autoUpdate !== "boolean") return refuse("autoUpdate must be a boolean");
      writes.push(() => settings.setAutoUpdate(autoUpdate));
    }
    if (body?.terminalInitCommand !== undefined) {
      const command = normalizeTerminalInitCommand(body.terminalInitCommand);
      if (command === null) return refuse("terminalInitCommand must be one line of at most 500 characters");
      writes.push(() => settings.setTerminalInitCommand(command));
    }
    /** The blocks this request declares, or null when it does not touch them.
     *  Adding a tool is declaring it *and* switching it on, so a name declared
     *  here is switchable in the same write. */
    let declared: CustomTool[] | null = null;
    if (body?.customTools !== undefined) {
      const validated = validateCustomTools?.(body.customTools) ??
        { error: "this Pier cannot store custom tools" };
      if ("error" in validated) return refuse(validated.error);
      declared = validated.tools;
      const custom = validated.tools;
      writes.push(() => settings.setCustomTools(custom));
    }
    /** A single switch, applied to the set as it is *now* rather than to the
     *  list the browser had. Returns the name, or the refusal. */
    const delta = (raw: unknown): { name: string; on: boolean } | string => {
      const given = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
      const name = typeof given?.name === "string" ? given.name.trim() : "";
      if (!name || name.length > 64 || typeof given?.on !== "boolean") return "expected {name, on}";
      return { name, on: given.on };
    };
    let extensionOne: { name: string; on: boolean } | null = null;
    if (body?.extension !== undefined) {
      const one = delta(body.extension);
      if (typeof one === "string") return refuse(`extension: ${one}`);
      extensionOne = one;
      writes.push(() => settings.setExtensions(withName(settings.get().extensions, one)));
    }
    // Whether the enabled set moved, for the install below. The delta itself
    // is resolved inside the transaction, against the set as it was stored.
    let toolsChanged = false;
    let toolOne: { name: string; on: boolean } | null = null;
    if (body?.tool !== undefined) {
      const one = delta(body.tool);
      if (typeof one === "string") return refuse(`tool: ${one}`);
      toolOne = one;
      toolsChanged = true;
      writes.push(() => settings.setTools(withName(settings.get().tools, one)));
    }

    // What ubix says about the blocks this request would undeclare. Asked out
    // here because answering it spawns a subprocess, and a transaction may not
    // wait on one; the *sets* below are read inside the transaction, where
    // nothing can move them.
    const dropping = declared !== null &&
      settings.get().customTools.some((tool) => !declared?.some((kept) => kept.name === tool.name));
    const shown = dropping ? await catalog?.() : undefined;
    const binaryOf = (name: string): CatalogBinary | null => {
      const entry = shown?.entries.find((row) => row.source === "binary" && row.name === name);
      return entry?.source === "binary" ? entry.binary : null;
    };

    /**
     * The rules that are about *sets*, applied inside the transaction against
     * the settings as they are at that instant. Outside it they are a
     * time-of-check: a request dropping a declaration and another switching
     * that tool on both passed, and left an enabled tool nothing declares.
     *
     * What may be switched on comes from `names`, which is code and cannot
     * change while this runs, plus what this request declares. What may be
     * undeclared is the second rule: a block is the only thing that can
     * uninstall its binary, so it may not go while the tool is on, installed,
     * broken, or while ubix's answer about it could not be read. Switching a
     * name *off* is never refused — that is the repair, and it is the first
     * half of removing one.
     */
    const check = (): void => {
      const current = settings.get();
      const after = (declared ?? current.customTools).map((tool) => tool.name);
      const toolsAfter = toolOne ? withName(current.tools, toolOne) : current.tools;
      if (extensionOne?.on && !names.extensions.includes(extensionOne.name)) {
        throw new Refusal(`extension: this Pier has no extension called ${extensionOne.name}`, 400);
      }
      if (toolOne?.on && !names.tools.includes(toolOne.name) && !after.includes(toolOne.name)) {
        throw new Refusal(`tool: this Pier manages no tool called ${toolOne.name}`, 400);
      }
      for (const gone of current.customTools.filter((tool) => !after.includes(tool.name))) {
        if (toolsAfter.includes(gone.name)) {
          throw new Refusal(`${gone.name} is still switched on — switch it off first, so the next sync uninstalls it`, 409);
        }
        const binary = binaryOf(gone.name);
        if (!binary) throw new Refusal(`${gone.name}: Pier cannot read what is installed, so its block stays for now`, 409);
        if (binary.installed) {
          throw new Refusal(`${gone.name} is still installed — its block stays until ubix reports the binary gone`, 409);
        }
        if (binary.error) throw new Refusal(`${gone.name}: ${binary.error} — its block stays until that is resolved`, 409);
      }
    };

    try {
      settings.transact(() => {
        check();
        for (const write of writes) write();
      });
    } catch (err) {
      // Nothing was written: the transaction rolled back with it.
      if (err instanceof Refusal) return c.json({ error: err.message }, err.status);
      throw err;
    }
    // Stored first, then acted on: the switch shows what was written even when
    // the install cannot start — and then says why, here, rather than leaving
    // "saved" as the last thing anyone was told.
    const note = toolsChanged ? await onToolsChanged?.() : null;
    // The URL and the extension set are both read when a session opens; the
    // model menu is read per picker call, so it needs no recycle.
    if (body?.publicUrl !== undefined || body?.extension !== undefined) onSettingsChanged?.();
    return c.json({ ...(await instanceSettings()), ...(note ? { toolsSync: note } : {}) });
  });

  // Layer-1 key status and control (Console → Settings → Security). The GET
  // is what a locked instance shows; unlock is how it recovers without a
  // restart, and rotate is the only way to change how the KEK is protected.
  const secretsStatus = () => ({
    state: secrets.state,
    mode: secrets.mode ?? null,
    ...(secrets.state === "locked" ? { reason: secrets.lockedReason } : {}),
  });

  app.get("/api/secrets", (c) => c.json(secretsStatus()));

  app.post("/api/secrets/unlock", async (c) => {
    try {
      await secrets.unlock();
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    onUnlocked?.();
    return c.json(secretsStatus());
  });

  app.post("/api/secrets/rotate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    if (body.mode !== undefined && body.mode !== "vt" && body.mode !== "file") {
      return c.json({ error: "mode must be vt or file" }, 400);
    }
    try {
      await secrets.rotateKek(body.mode);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    return c.json(secretsStatus());
  });
}
