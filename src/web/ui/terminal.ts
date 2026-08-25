// Console → Terminal view: a real shell in a project's cwd. The pty lives on
// the server (web/terminal.ts) and every open page mirrors it — same shell,
// any page may type, last resize wins, and the Fit button forces this page's
// size when another window shrank it. The view stays mounted and connected
// while hidden, so toggling it back is instant and loses nothing; the server
// replays recent output when a page attaches fresh.

import { failure, sendJson } from "./api.js";
import { openBrowser } from "./dir-picker.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { setStatus as setFieldStatus, type SaveState } from "./form.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";

type Ghostty = typeof import("ghostty-web");
type TerminalPrefs = { fontFamily: string; fontSize: number; cursorBlink: boolean };

const PREFS_KEY = "pier.terminalPrefs";
const DEFAULT_PREFS: TerminalPrefs = { fontFamily: "monospace", fontSize: 14, cursorBlink: true };
const loadPrefs = (): TerminalPrefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<TerminalPrefs> | null;
    const size = typeof raw?.fontSize === "number" ? raw.fontSize : DEFAULT_PREFS.fontSize;
    return {
      fontFamily: typeof raw?.fontFamily === "string" && raw.fontFamily.trim()
        ? raw.fontFamily.slice(0, 200)
        : DEFAULT_PREFS.fontFamily,
      fontSize: Math.round(Math.max(10, Math.min(24, size))),
      cursorBlink: typeof raw?.cursorBlink === "boolean" ? raw.cursorBlink : DEFAULT_PREFS.cursorBlink,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

const savePrefs = (prefs: TerminalPrefs): void =>
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

// The emulator is ~660KB with its WASM inlined — loaded on first open, never
// in the main bundle, and initialized exactly once. A failed load resets the
// cache so the visible Retry action can actually retry.
let ghosttyOnce: Promise<Ghostty> | null = null;
const loadGhostty = (): Promise<Ghostty> => {
  if (!ghosttyOnce) {
    ghosttyOnce = import("ghostty-web").then(async (mod) => {
      await mod.init();
      return mod;
    }).catch((err: unknown) => {
      ghosttyOnce = null;
      throw err;
    });
  }
  return ghosttyOnce;
};

const THEME = { background: "#1a1b26", foreground: "#a9b1d6", cursor: "#c0caf5" };
/** The ⚙ panel's text fields — narrower and denser than a Settings card's. */
const FIELD =
  "w-full rounded border border-neutral-300 px-2 py-1.5 font-mono text-[12px] outline-none focus:border-indigo-400";

export function createTerminalView(
  root: HTMLElement,
  projectCwds: () => string[],
  /** Where a bare open lands: the selected session's project. */
  defaultCwd: () => string | undefined,
  /** Through the router (hash), so Back walks cwd switches too. */
  openDir: (dir: string) => void,
  /** The ✕: leave the view, back to wherever it was opened from. */
  close: () => void,
): ConsoleView {
  let cwd = "";
  let term: InstanceType<Ghostty["Terminal"]> | null = null;
  let fit: InstanceType<Ghostty["FitAddon"]> | null = null;
  let ws: WebSocket | null = null;
  let ended = false; // the shell exited or refused; don't overwrite that with "disconnected"
  let epoch = 0; // a stale boot() resolving after a cwd switch must do nothing
  let prefs = loadPrefs();

  const statusBox = h("div", "ml-auto flex min-w-0 flex-none items-center gap-2");
  const header = h("header", "flex h-10 flex-none items-center gap-2 border-b border-neutral-200 bg-white px-3");
  const box = h("div", "min-h-0 flex-1 overflow-hidden p-1");
  box.style.background = THEME.background;
  // Ctrl chords belong to the shell. Pier's Cmd chords run first at document
  // capture (shortcut.ts); every unmatched Cmd chord bypasses ghostty-web so
  // browser defaults such as Cmd+R still work.
  box.setAttribute("data-owns-keyboard", "");
  box.addEventListener("keydown", (ev) => {
    if (ev.metaKey && !ev.defaultPrevented) ev.stopImmediatePropagation();
  }, true);
  root.append(header, box);

  const chip = (label: string): HTMLButtonElement => {
    const el = h(
      "button",
      "min-w-0 max-w-72 cursor-pointer truncate rounded-md bg-neutral-100 px-2 py-0.5 text-left font-mono text-[11.5px] text-neutral-600 hover:bg-neutral-200",
      label,
    ) as HTMLButtonElement;
    el.type = "button";
    return el;
  };

  /** The connection's state, always visible — a dead shell must never look
   *  like a live one (an `action` chip carries the way back). */
  function setStatus(text: string, action?: { label: string; run: () => void }): void {
    statusBox.replaceChildren();
    if (text) statusBox.append(h("span", "min-w-0 truncate text-[11.5px] text-neutral-400", text));
    if (action) {
      const btn = chip(action.label);
      btn.className = btn.className.replace("bg-neutral-100", "bg-indigo-50 font-medium text-indigo-700 hover:bg-indigo-100");
      btn.onclick = action.run;
      statusBox.append(btn);
    }
  }

  /** Apply browser-local presentation without touching the shared pty. */
  function applyPrefs(): void {
    if (!term) return;
    term.options.fontFamily = prefs.fontFamily;
    term.options.fontSize = prefs.fontSize;
    term.options.cursorBlink = prefs.cursorBlink;
    requestAnimationFrame(() => {
      fit?.fit();
      sendResize();
    });
  }

  /** The one shared, server-side setting on this panel: the command every new
   *  shell is handed as it starts. Loaded per open so an edit made in another
   *  window shows, and saved on Enter or blur rather than per keystroke —
   *  half a command must never reach a tty. Outside-click closes the panel and
   *  blurs the field in the same gesture, so a save that fails after that is
   *  reported on the header instead, where the panel no longer is. */
  function initCommandSection(): HTMLElement {
    const cmd = document.createElement("input");
    cmd.type = "text";
    cmd.placeholder = 'tmux new -As "$(basename $PWD)"';
    cmd.spellcheck = false;
    cmd.autocomplete = "off";
    cmd.autocapitalize = "off"; // a phone keyboard would capitalize the command
    cmd.disabled = true; // until the stored value lands, so it cannot be overwritten blind
    cmd.className = `${FIELD} disabled:bg-neutral-50`;
    const status = h("span", "block text-[11.5px] text-neutral-400", "loading…");
    const report = (state: SaveState, text: string): void => {
      if (status.isConnected) setFieldStatus(status, state, text);
      else if (state === "failed") setStatus(text);
    };
    let stored = "";
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error(await failure(res, "Could not load the startup command"));
        stored = ((await res.json()) as { terminalInitCommand?: string }).terminalInitCommand ?? "";
        cmd.value = stored;
        cmd.disabled = false;
        report("idle", "Runs when a shell starts — this one is already up.");
      } catch (err) {
        report("failed", String(err));
      }
    })();
    const save = async (): Promise<void> => {
      const next = cmd.value.trim();
      if (cmd.disabled || next === stored) return;
      report("saving", "saving…");
      try {
        const res = await sendJson("/api/settings", { terminalInitCommand: next }, "PUT");
        if (!res.ok) return report("failed", await failure(res, "Could not save the startup command"));
        stored = ((await res.json()) as { terminalInitCommand: string }).terminalInitCommand;
        cmd.value = stored;
        report("saved", stored ? "Saved — the next shell runs it." : "Cleared.");
      } catch (err) {
        report("failed", `Could not save the startup command: ${String(err)}`);
      }
    };
    cmd.onblur = () => void save();
    cmd.onkeydown = (ev) => {
      if (ev.key === "Enter") void save();
    };
    return h(
      "div",
      "space-y-1.5 border-t border-neutral-200 pt-2.5",
      h(
        "div",
        "",
        h("span", "text-[12px] font-semibold text-neutral-700", "Startup command"),
        h("span", "block text-[11px] text-neutral-400", "This Pier, every shell — not only this browser."),
      ),
      cmd,
      status,
    );
  }

  function openSettings(anchor: HTMLElement): void {
    const font = document.createElement("input");
    font.type = "text";
    font.value = prefs.fontFamily;
    font.setAttribute("list", "terminal-font-presets");
    font.className = FIELD;
    const presets = document.createElement("datalist");
    presets.id = "terminal-font-presets";
    for (const value of [
      "monospace",
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      "JetBrains Mono, monospace",
      "Cascadia Mono, monospace",
      "Fira Code, monospace",
    ]) {
      const option = document.createElement("option");
      option.value = value;
      presets.append(option);
    }
    const size = document.createElement("input");
    size.type = "number";
    size.min = "10";
    size.max = "24";
    size.step = "1";
    size.value = String(prefs.fontSize);
    size.className = "w-20 rounded border border-neutral-300 px-2 py-1.5 text-[12px] outline-none focus:border-indigo-400";
    const blink = document.createElement("input");
    blink.type = "checkbox";
    blink.checked = prefs.cursorBlink;
    blink.className = "h-4 w-4 accent-indigo-600";
    const commit = (): void => {
      const family = font.value.trim();
      const fontSize = Number(size.value);
      if (!family || !Number.isFinite(fontSize)) return;
      prefs = {
        fontFamily: family.slice(0, 200),
        fontSize: Math.round(Math.max(10, Math.min(24, fontSize))),
        cursorBlink: blink.checked,
      };
      size.value = String(prefs.fontSize);
      savePrefs(prefs);
      applyPrefs();
    };
    font.oninput = commit;
    size.oninput = commit;
    blink.onchange = commit;
    const reset = h("button", "cursor-pointer text-[12px] text-neutral-500 hover:text-indigo-700", "Reset") as HTMLButtonElement;
    reset.type = "button";
    reset.onclick = () => {
      prefs = { ...DEFAULT_PREFS };
      font.value = prefs.fontFamily;
      size.value = String(prefs.fontSize);
      blink.checked = prefs.cursorBlink;
      savePrefs(prefs);
      applyPrefs();
    };
    openPanel(
      anchor,
      h(
        "div",
        "w-72 space-y-3 px-3 py-2.5",
        h("div", "flex items-center", h("span", "text-[12px] font-semibold text-neutral-700", "Terminal"), h("span", "ml-auto", reset)),
        h("label", "block space-y-1 text-[11.5px] text-neutral-500", h("span", "", "Font family"), font, presets),
        h("label", "flex items-center justify-between text-[11.5px] text-neutral-500", h("span", "", "Font size"), size),
        h("label", "flex cursor-pointer items-center justify-between text-[11.5px] text-neutral-500", h("span", "", "Blinking cursor"), blink),
        initCommandSection(),
      ),
    );
  }

  function renderHeader(): void {
    const cwdChip = chip(cwd || "Choose a folder…");
    cwdChip.title = "Switch folder";
    cwdChip.onclick = () =>
      openMenu(cwdChip, [
        ...projectCwds().map((c) => ({
          label: c,
          onSelect: () => {
            closeMenu();
            if (c !== cwd) openDir(c); // hash first; show() reboots
          },
        })),
        { label: "Browse…", onSelect: () => openBrowser(cwdChip, cwd || undefined, openDir) },
      ]);
    const fitBtn = chip("Fit");
    fitBtn.title = "Resize the shell to this window";
    fitBtn.onclick = () => {
      // Unconditional send: after another page shrank the pty, this page's own
      // dimensions haven't changed, so fit() alone would say nothing.
      fit?.fit();
      sendResize();
      term?.focus();
    };
    const settingsBtn = h("button", "icon-btn text-[15px]", "⚙") as HTMLButtonElement;
    settingsBtn.type = "button";
    settingsBtn.title = "Terminal settings";
    settingsBtn.setAttribute("aria-label", "Terminal settings");
    settingsBtn.onclick = () => openSettings(settingsBtn);
    const closeBtn = h("button", "icon-btn", "✕") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.title = "Close Terminal";
    closeBtn.setAttribute("aria-label", "Close Terminal");
    closeBtn.onclick = close;
    header.replaceChildren(cwdChip, statusBox, fitBtn, settingsBtn, closeBtn);
  }

  const sendResize = (): void => {
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  function teardown(): void {
    ws?.close();
    ws = null;
    fit = null;
    term?.dispose();
    term = null;
    box.replaceChildren();
  }

  async function boot(): Promise<void> {
    const mine = ++epoch;
    teardown();
    ended = false;
    setStatus("connecting…");
    let g: Ghostty;
    try {
      g = await loadGhostty();
    } catch (err) {
      setStatus(`could not load the terminal: ${String(err)}`, { label: "Retry", run: () => void boot() });
      return;
    }
    if (mine !== epoch) return;
    term = new g.Terminal({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      cursorBlink: prefs.cursorBlink,
      scrollback: 10_000,
      theme: THEME,
    });
    term.open(box);
    fit = new g.FitAddon();
    term.loadAddon(fit);
    fit.observeResize(); // sidebar, viewport and mobile-keyboard resizes
    fit.fit();
    const sock = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?cwd=${encodeURIComponent(cwd)}`,
    );
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      if (mine !== epoch) return;
      setStatus("");
      sendResize(); // this page's size, before any output renders
      term?.focus();
    };
    sock.onmessage = (ev) => {
      if (mine !== epoch) return;
      if (typeof ev.data !== "string") {
        term?.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: { t?: string; code?: number; message?: string };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        ended = true;
        setStatus("invalid terminal response", { label: "Reconnect", run: () => void boot() });
        sock.close();
        return;
      }
      if (msg.t === "exit") {
        ended = true;
        setStatus(`shell exited (${msg.code ?? "?"})`, { label: "Restart", run: () => void boot() });
      } else if (msg.t === "error") {
        ended = true;
        setStatus(msg.message ?? "terminal error", { label: "Retry", run: () => void boot() });
      }
    };
    sock.onclose = () => {
      if (mine !== epoch || ended) return;
      setStatus("disconnected", { label: "Reconnect", run: () => void boot() });
    };
    term.onData((d) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "in", d }));
    });
    term.onResize(({ cols, rows }) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "resize", cols, rows }));
    });
  }

  return consoleView(root, (arg) => {
    // Any absolute path is addressable; a stale or relative one falls back.
    const next = arg?.startsWith("/") ? arg : cwd || defaultCwd() || projectCwds()[0] || "";
    if (next === cwd && term) {
      renderHeader();
      // The connection died while the view was hidden (a Pier restart kills
      // every pty): reattach rather than present a dead shell as live. An
      // exit the user asked for keeps its status and Restart chip instead.
      if (!ended && ws && ws.readyState > WebSocket.OPEN) void boot();
      else term.focus();
      return;
    }
    cwd = next;
    renderHeader();
    if (!cwd) {
      setStatus("No project yet — pick a folder from the chip.");
      return;
    }
    void boot();
  }, closeMenu);
}
