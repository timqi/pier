// Routes about the Pier instance itself: settings, updates, secrets control,
// the browser's error reports. Nothing here touches a session.

import type { Hono } from "hono";
import type { CatalogBinary, CatalogEntry } from "../core/types.js";
import { logger } from "../log.js";
import type { SecretsMode } from "../secrets.js";
import {
  normalizeModelMenu,
  normalizeModelRef,
  normalizePublicUrl,
  type SettingsStore,
} from "../settings.js";
// Type-only: erased at build, so web/ runs nothing from tools.ts.
import type { CustomTool } from "../tools.js";
import type { ToolsSyncNote } from "./types.js";
import type { UpdateCheck } from "../update.js";

/** Injected so web/ never learns what systemd is, and the install never runs
 *  as a child of the request that asked for it. */
export interface UpdateApplier {
  /** `busy`: another handover or a restart already owns the gate. */
  apply(): Promise<"started" | "busy" | "not-installed" | "failed">;
  /** A stale updater is otherwise invisible until the update that needed it (§5). */
  problem(): string | null;
}

/** Never exposes key material: state, mode and the locked reason are all a
 *  browser may see. */
export interface SecretsControl {
  readonly state: "locked" | "unlocked";
  readonly mode: SecretsMode | undefined;
  readonly lockedReason: string;
  unlock(): Promise<void>;
  rotateKek(mode?: SecretsMode): Promise<void>;
  /** vt's own read-only report, no values. */
  doctor(): Promise<string>;
}

/** A rule that failed inside the transaction, distinct from a real fault: 400
 *  for a name this Pier does not have, 409 for a collision with current state. */
class Refusal extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

const withName = (current: readonly string[], { name, on }: { name: string; on: boolean }): string[] =>
  on ? [...new Set([...current, name])] : current.filter((each) => each !== name);

/** A browser bug can fire in a loop, and the journal is shared. */
const CLIENT_LOG_PER_MINUTE = 60;

export function registerInstanceRoutes(
  app: Hono,
  deps: {
    settings: SettingsStore;
    updates: UpdateCheck;
    /** `null` when no service manager owns this process. */
    updater?: UpdateApplier | null;
    secrets: SecretsControl;
    /** Handed over as data by main.ts: the catalog imports the Pi SDK and
     *  spawns ubix, and web/ may do neither. */
    catalog?: () => Promise<{ entries: CatalogEntry[]; toolsTaskId: string | null }>;
    /** Code, not state: a switch is validated against these, not against the
     *  catalog, whose custom half the same request may be rewriting. */
    names?: { extensions: readonly string[]; tools: readonly string[] };
    /** What became of the install belongs on the switch, not only in the
     *  journal (§5). Reads the stored set itself. */
    onToolsChanged?: () => Promise<ToolsSyncNote | null>;
    /** The rule lives with the installer (src/tools.ts), which web/ may not import. */
    validateCustomTools?: (raw: unknown) => { tools: CustomTool[] } | { error: string };
    /** A callback because web/ must not import channels/. */
    onUnlocked?: () => void;
    /** The public URL rides in the prompt a session opens with; idle ones are recycled. */
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
  // A busy Pier drains first, which can take minutes, and a response held that
  // long dies at every proxy: past this cap the answer is "draining".
  const APPLY_REPLY_CAP_MS = 10_000;

  // A workbench that threw after the response left is otherwise invisible here.
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
    // ua included: "only on iOS" is the answer half these questions have.
    clientLog.warn(
      `${cap(body.message, 500)} [${where || "/"}] ${cap(c.req.header("user-agent"), 160)}` +
        (stack ? `\n${stack}` : ""),
    );
    return c.body(null, 204);
  });

  // The catalog rides along so the switches cannot disagree with the setting
  // they are drawn from. One shape for read and write.
  const instanceSettings = async () => {
    const shown = await catalog?.();
    return {
      ...settings.get(),
      catalog: shown?.entries ?? [],
      /** The install and every daily update is one task's history. */
      toolsTaskId: shown?.toolsTaskId ?? null,
    };
  };

  app.get("/api/settings", async (c) => c.json(await instanceSettings()));

  // `statusNow` so a browser opened seconds after a restart is told the truth.
  app.get("/api/update", async (c) =>
    c.json({
      ...(await updates.statusNow()),
      canApply: updater !== null,
      autoUpdate: settings.get().autoUpdate,
      // Whether or not an update is pending: the next restart is too late.
      problem: updater?.problem() ?? null,
    }));

  // Handed to the service manager's oneshot unit: an npm child of this
  // process would be killed by the very restart it is performing.
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
      // If the handover fails later, main.ts reports it and reopens the gate (§5).
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

  // Partial: each surface sends only what it edits. A switch sends a delta,
  // not a list: two quick clicks each carrying a list would drop one.
  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | {
        publicUrl?: unknown;
        modelMenu?: unknown;
        titleModel?: unknown;
        autoUpdate?: unknown;
        customTools?: unknown;
        extension?: unknown;
        tool?: unknown;
      }
      | null;
    const fields = body
      ? [body.publicUrl, body.modelMenu, body.titleModel, body.autoUpdate, body.customTools, body.extension, body.tool]
      : [];
    if (!fields.some((v) => v !== undefined)) {
      return c.json({
        error: "publicUrl, modelMenu, titleModel, autoUpdate, customTools, extension or tool required",
      }, 400);
    }
    // One transaction: a new custom tool and the switch that turns it on must
    // not leave one of the two stored.
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
    if (body?.titleModel !== undefined) {
      // null is the off switch; anything else has to be a model.
      const ref = body.titleModel === null ? null : normalizeModelRef(body.titleModel);
      if (ref === null && body.titleModel !== null) return refuse("titleModel must be {provider, id} or null");
      writes.push(() => settings.setTitleModel(ref));
    }
    if (body?.autoUpdate !== undefined) {
      const { autoUpdate } = body;
      if (typeof autoUpdate !== "boolean") return refuse("autoUpdate must be a boolean");
      writes.push(() => settings.setAutoUpdate(autoUpdate));
    }
    /** Null when the request does not touch them; a name declared here is
     *  switchable in the same write. */
    let declared: CustomTool[] | null = null;
    if (body?.customTools !== undefined) {
      const validated = validateCustomTools?.(body.customTools) ??
        { error: "this Pier cannot store custom tools" };
      if ("error" in validated) return refuse(validated.error);
      declared = validated.tools;
      const custom = validated.tools;
      writes.push(() => settings.setCustomTools(custom));
    }
    /** Applied to the set as it is now, not the list the browser had. */
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
    let toolsChanged = false;
    let toolOne: { name: string; on: boolean } | null = null;
    if (body?.tool !== undefined) {
      const one = delta(body.tool);
      if (typeof one === "string") return refuse(`tool: ${one}`);
      toolOne = one;
      toolsChanged = true;
      writes.push(() => settings.setTools(withName(settings.get().tools, one)));
    }

    // Asked outside the transaction: it spawns a subprocess.
    const dropping = declared !== null &&
      settings.get().customTools.some((tool) => !declared?.some((kept) => kept.name === tool.name));
    const shown = dropping ? await catalog?.() : undefined;
    const binaryOf = (name: string): CatalogBinary | null => {
      const entry = shown?.entries.find((row) => row.source === "binary" && row.name === name);
      return entry?.source === "binary" ? entry.binary : null;
    };

    /** Inside the transaction, or two requests both pass and leave an enabled
     *  tool nothing declares. A block is the only thing that can uninstall its
     *  binary, so it may not go while the tool is on, installed or broken;
     *  switching off is never refused, being the first half of removing one. */
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
      if (err instanceof Refusal) return c.json({ error: err.message }, err.status);
      throw err;
    }
    // Stored first: the switch shows what was written even when the install
    // cannot start, and then says why.
    const note = toolsChanged ? await onToolsChanged?.() : null;
    // Read when a session opens; the model menu is read per picker call.
    if (body?.publicUrl !== undefined || body?.extension !== undefined) onSettingsChanged?.();
    return c.json({ ...(await instanceSettings()), ...(note ? { toolsSync: note } : {}) });
  });

  // Layer-1 key status and control; unlock is how a locked instance recovers
  // without a restart.
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

  // Safe while locked; without it "locked" is one error string and no way to repair.
  app.get("/api/secrets/doctor", async (c) => {
    try {
      return c.json({ report: await secrets.doctor() });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
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
