// Settings → Channels: one tab per IM platform, a pure consumer of
// /api/channels/:platform.

import { Check, LoaderCircle, TriangleAlert } from "lucide";
import { icon } from "./icons.js";
import type { ModelRef } from "../../core/types.js";
import type { AgentDefaults } from "../../agent/types.js";
import type { ChannelConfig, ChannelPlatform, ChannelView, ChatConfig, ChatKind } from "../../channels/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { getJson, sendJson } from "./api.js";
import {
  larkThreadHelp,
  larkTokenHelp,
  slackThreadHelp,
  slackTokenHelp,
} from "./channel-help.js";
import { dirInput } from "./dir-picker.js";
import { chevron, consoleView, h, type ConsoleView } from "./dom.js";
import { badge, btn, button, card, empty, field, rowActionClass, segmented, STATUS_TONE, textInput, toggle } from "./form.js";
import { launchField, type LaunchChoice } from "./model-picker.js";

const PLATFORMS: [ChannelPlatform, string][] = [["slack", "Slack"], ["lark", "Lark"]];

const KIND_STYLE: Record<ChatKind, string> = {
  dm: "bg-sky-50 text-sky-700 ring-sky-200",
  group: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

const CHATS_NOTE = "Discovered from inbound traffic — no platform reliably lists every chat a bot is in.";

/** A row no message has restamped under the current bot. */
const isStale = (cfg: ChannelConfig, chat: ChatConfig): boolean => chat.botId !== cfg.botId;
/** What a session launches with; a chat's row resolves each empty field one level up. */
type Launch = LaunchChoice & { cwd: string };

// --- view ---------------------------------------------------------------------

const PLATFORM_KEY = "pier.channelsPlatform";

export function createChannelsView(root: HTMLElement): ConsoleView {
  const stored = localStorage.getItem(PLATFORM_KEY);
  let platform: ChannelPlatform = PLATFORMS.some(([id]) => id === stored)
    ? (stored as ChannelPlatform)
    : "slack";
  let config: ChannelConfig | null = null;
  /** The directory an empty platform cwd resolves to, as the server names it. */
  let workspace = "";
  /** Rows open for editing, "" the platform default's; kept across re-renders. */
  const expanded = new Set<string>();
  const followsCwd = (cfg: ChannelConfig): string => `Default (${cfg.cwd || workspace})`;
  let models: ModelRef[] = [];
  /** Settings → Models' default, what a platform left on Default resolves to. */
  let settingsDefault: LaunchChoice = { model: null, thinking: null };
  /** Chat cwd inputs on Default, whose placeholder names the platform's as it is typed. */
  let cwdFollowers: HTMLInputElement[] = [];

  // Segmented, not a second pill strip: two rows of the same chrome read as
  // two levels of one navigation. Sticky, so a long page still names the
  // platform being edited.
  const statusBox = h("div", "ml-auto flex items-center gap-1.5 text-[11.5px]");
  // top-[-8px] is the strip's own inset, so it sticks flush against the scrollport.
  const tabs = h("div", "pagehead pagehead-hug sticky top-[-8px] z-30", statusBox);
  const pane = h("div", "px-4 pb-5 pt-4");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", tabs, pane));

  function renderTabs(): void {
    tabs.replaceChildren(
      segmented<ChannelPlatform>(
        PLATFORMS.map(([id, label]) => [label, id]),
        platform,
        (next) => {
          if (saveTimer) flush();
          platform = next;
          localStorage.setItem(PLATFORM_KEY, next);
          void load();
        },
      ),
      statusBox,
    );
  }

  // --- autosave ----------------------------------------------------------------
  // Saves are serialized and coalesced: `config` is mutated in place, so a
  // save that waited sends the latest state.
  const SAVE_DEBOUNCE_MS = 500;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  /** The save that has to run once the in-flight one lands. */
  let pending: { platform: ChannelPlatform; config: ChannelConfig } | null = null;

  function showStatus(state: "clean" | "saving" | "saved" | "failed"): void {
    statusBox.replaceChildren();
    if (state === "clean") return;
    statusBox.className = `ml-auto flex items-center gap-1.5 text-[11.5px] ${STATUS_TONE[state]}`;
    if (state === "saving") {
      statusBox.append(icon(LoaderCircle, "spinner"), h("span", "", "Saving…"));
    } else if (state === "saved") {
      statusBox.append(icon(Check), h("span", "", "Saved"));
      // Fade the receipt: a permanent "Saved" says nothing about the next edit.
      setTimeout(() => {
        if (statusBox.textContent?.includes("Saved")) showStatus("clean");
      }, 2000);
    } else {
      const retry = btn("Retry", "cursor-pointer underline");
      retry.onclick = flush;
      statusBox.append(icon(TriangleAlert), h("span", "", "Save failed"), retry);
    }
  }

  /** Ask for a save. Immediate feedback, deferred request. */
  function queueSave(): void {
    showStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  /** Write-through: a control assigns into the config, then asks for a save. */
  const set = <T,>(assign: (v: T) => void) => (v: T): void => {
    assign(v);
    queueSave();
  };

  /** The platform travels with the save: one deferred behind an in-flight save
   *  must not land on whichever tab was opened meanwhile. */
  async function send(target: { platform: ChannelPlatform; config: ChannelConfig }): Promise<void> {
    saving = true;
    showStatus("saving");
    try {
      const res = await sendJson(`/api/channels/${target.platform}`, target.config, "PUT");
      showStatus(res.ok ? "saved" : "failed");
    } catch {
      showStatus("failed");
    } finally {
      saving = false;
      const next = pending;
      pending = null;
      if (next) void send(next);
    }
  }

  function flush(): void {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!config) return;
    const target = { platform, config };
    if (saving) pending = target;
    else void send(target);
  }

  async function load(): Promise<void> {
    // The catalogue once per view visit; the Settings default on every load,
    // since Settings → Models may have moved it while this page was open.
    const [list, defaults, got] = await Promise.all([
      models.length ? null : getJson<ModelRef[]>("/api/models", "Could not load the model catalog"),
      getJson<AgentDefaults>("/api/config/defaults", "Could not read the Settings default model"),
      getJson<ChannelView>(`/api/channels/${platform}`, "Failed to load"),
    ]);
    if (list?.ok) models = list.value;
    if (defaults.ok) settingsDefault = { model: defaults.value.defaultModel, thinking: defaults.value.defaultThinkingLevel };
    else showStatus("failed");
    if (!got.ok) {
      config = null;
      renderTabs();
      pane.replaceChildren(empty(got.error));
      return;
    }
    const { workspace: dir, ...rest } = got.value;
    workspace = dir;
    config = rest;
    if (defaults.ok) showStatus("clean");
    render();
  }

  // --- cards -------------------------------------------------------------------

  function connection(cfg: ChannelConfig): HTMLElement {
    const lark = platform === "lark";
    const token = textInput(cfg.token, lark ? "cli_…" : "xoxb-…", set((v) => (cfg.token = v)), true);
    // Slack authenticates its event socket separately from its Web API; Lark
    // signs everything with an App ID + App Secret pair. Either way the
    // adapter needs both credentials before it can start.
    const appToken = textInput(cfg.appToken, lark ? "" : "xapp-…", set((v) => (cfg.appToken = v)), true);
    return card(
      "Connection",
      lark
        ? "Pier connects over Feishu's WebSocket long connection; no public URL or webhook needed."
        : "Pier connects over Socket Mode; no public URL or webhook needed.",
      toggle("Enabled", "Start the adapter when Pier boots.", cfg.enabled, set((v) => {
        cfg.enabled = v;
        renderTabs();
      })),
      field(lark ? "App ID" : "Bot token", token, {
        hint: "Stored locally, shown masked once saved.",
        help: lark ? larkTokenHelp() : slackTokenHelp(),
      }),
      lark
        ? field("App Secret", appToken, { hint: "From Credentials & Basic Info, beside the App ID." })
        : field("App-level token", appToken, { hint: "Opens the Socket Mode connection. Needs connections:write." }),
      // Threads are the whole design on both platforms, so the explanation is a
      // fact on the card, not a setting.
      h(
        "span",
        "flex items-center gap-1.5 text-[13px] text-neutral-400",
        h("span", "", lark ? "Every topic is its own session." : "Every thread is its own session."),
        lark ? larkThreadHelp() : slackThreadHelp(),
      ),
    );
  }

  function users(cfg: ChannelConfig): HTMLElement {
    const codeText = h("span", "font-mono text-[15px] font-semibold tracking-widest");
    const codeBox = h(
      "div",
      "hidden items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-[12.5px] text-indigo-800",
      codeText,
      h("span", "text-[11.5px] text-indigo-500", "DM the bot /bind <code> · expires in 10 min"),
    );
    const issue = button("Generate bind code");
    issue.onclick = async () => {
      const res = await fetch(`/api/channels/${platform}/bind-code`, { method: "POST" });
      if (!res.ok) return;
      const { code: value } = (await res.json()) as { code: string };
      codeText.textContent = value;
      codeBox.classList.replace("hidden", "flex");
    };

    const list = h("div", "flex flex-col");
    if (!cfg.users.length) list.append(empty("No bound users yet."));
    for (const user of cfg.users) {
      const remove = btn("Remove", rowActionClass());
      remove.onclick = async () => {
        await fetch(`/api/channels/${platform}/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
        await load();
      };
      list.append(h(
        "div",
        "group flex items-center gap-2.5 border-b border-neutral-100 py-2 last:border-0",
        h("span", "flex h-6 w-6 flex-none items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold text-neutral-500", (user.name[0] ?? "?").toUpperCase()),
        h("span", "min-w-0 flex-1 truncate text-[13px] text-neutral-700", user.name),
        h("span", "flex-none font-mono text-[11.5px] text-neutral-400", user.id),
        remove,
      ));
    }
    return card(
      "Bound users",
      "A code is single-use and expires; redeeming it in a DM binds that account.",
      list,
      h("div", "flex flex-col gap-2", issue, codeBox),
    );
  }

  /** One collapsible row, the platform default and every chat alike: the
   *  head names it and what it launches with, the body edits it. */
  function launchRow(
    key: string,
    parts: { name: string; dim: boolean; badges: HTMLElement[]; summary: () => HTMLElement; trailing?: HTMLElement },
    body: () => HTMLElement[],
  ): { el: HTMLElement; repaint: () => void } {
    const isOpen = expanded.has(key);
    const box = h("div", `group rounded-xl border border-neutral-200 transition-colors ${parts.dim ? "bg-neutral-50/60" : "bg-white"}`);
    // On a phone the summary takes its own line, aligned under the name past the chevron.
    const summary = h("span", "flex min-w-0 basis-full pl-5 sm:basis-0 sm:flex-1 sm:pl-0");
    const repaint = (): void => summary.replaceChildren(parts.summary());
    repaint();
    const toggleOpen = h(
      "button",
      `flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3.5 py-2.5 text-left pointer-coarse:min-h-11 ${isOpen ? "chev-open" : ""}`,
      chevron(),
      h("span", `min-w-0 truncate text-[13px] font-medium ${parts.dim ? "text-neutral-400" : "text-neutral-800"}`, parts.name),
      ...parts.badges,
      summary,
    );
    toggleOpen.setAttribute("type", "button");
    toggleOpen.setAttribute("aria-expanded", String(isOpen));
    toggleOpen.onclick = () => {
      if (isOpen) expanded.delete(key);
      else expanded.add(key);
      render();
    };
    const head = h("div", "flex items-center gap-2 pr-3.5", toggleOpen);
    if (parts.trailing) head.append(parts.trailing);
    box.append(head);
    if (isOpen) box.append(h("div", "flex flex-col gap-3 border-t border-neutral-100 px-3.5 pb-3.5 pt-3", ...body()));
    return { el: box, repaint };
  }

  /** `<cwd> · <model> <thinking>`: a value followed from the default is grey,
   *  one set here is ink. */
  function launchSummary(own: Launch, parent: Launch): HTMLElement {
    const part = (text: string, follows: boolean): HTMLElement =>
      h("span", follows ? "text-neutral-400" : "text-neutral-700", text);
    const cwd = own.cwd || parent.cwd;
    const model = own.model ?? parent.model;
    const thinking = own.thinking ?? parent.thinking;
    const line = h(
      "span",
      "min-w-0 truncate text-[12px]",
      part(cwd, !own.cwd),
      h("span", "text-neutral-300", " · "),
      part(model?.id ?? "Pi default", !own.model),
    );
    if (thinking) line.append(" ", part(thinkingLabel(thinking), !own.thinking));
    line.title = "Grey follows the default; dark is set here.";
    return line;
  }

  /** The row's footer: its reset, when anything is set, and its one destructive action. */
  function rowActions(onReset: (() => void) | null, remove?: HTMLElement, id?: string): HTMLElement {
    const bar = h("div", "flex flex-wrap items-center gap-3");
    if (id) bar.append(h("span", "font-mono text-[11px] text-neutral-400", id));
    bar.append(h("span", "flex-1"));
    if (onReset) {
      const reset = btn("Reset to default", "cursor-pointer text-[12px] text-neutral-500 hover:text-neutral-800 pointer-coarse:min-h-11");
      reset.onclick = onReset;
      bar.append(reset);
    }
    if (remove) bar.append(remove);
    return bar;
  }

  function platformRow(cfg: ChannelConfig, parent: Launch): HTMLElement {
    const row = launchRow("", {
      name: "Default",
      dim: false,
      badges: [badge("every chat", "bg-indigo-50 text-indigo-700 ring-indigo-200")],
      summary: () => launchSummary(cfg, parent),
    }, () => {
      const cwd = dirInput(cfg.cwd, `Default (${parent.cwd})`, set((v) => {
        cfg.cwd = v;
        for (const input of cwdFollowers) input.placeholder = followsCwd(cfg);
        row.repaint();
      }));
      return [
        h("p", "text-[12px] leading-normal text-neutral-500", "The two switches are copied into a group the first time the bot sees it and never touch one that exists. Directory, model and reasoning are read at every launch by each chat left on Default. DMs are always bound-users-only."),
        h(
          "div",
          "flex flex-wrap items-center gap-x-6 gap-y-2",
          toggle("Require mention in groups", "", cfg.requireMention, set((v) => (cfg.requireMention = v))),
          toggle("Require bound user", "", cfg.requireBind, set((v) => (cfg.requireBind = v))),
        ),
        h(
          "div",
          "grid grid-cols-1 gap-3 sm:grid-cols-2",
          field("Working directory", cwd.el),
          launchField("Model & reasoning", cfg, models, set((next) => {
            cfg.model = next.model;
            cfg.thinking = next.thinking;
            render();
          }), settingsDefault),
        ),
        rowActions(cfg.cwd || cfg.model || cfg.thinking ? () => {
          cfg.cwd = "";
          cfg.model = null;
          cfg.thinking = null;
          queueSave();
          render();
        } : null),
      ];
    });
    return row.el;
  }

  function chatRow(cfg: ChannelConfig, chat: ChatConfig, parent: Launch): HTMLElement {
    // A DM's id belongs to the bot that opened it, and two DMs with the same
    // person read identically: the row says whose it is, or nobody's.
    const stale = isStale(cfg, chat);
    const enabled = toggle("", "", chat.enabled, set((v) => {
      chat.enabled = v;
      render();
    }));
    enabled.classList.add("flex-none", "pointer-coarse:min-h-11");
    enabled.title = chat.enabled ? "Enabled" : "Disabled";
    const row = launchRow(`chat:${chat.id}`, {
      name: chat.name || chat.id,
      dim: !chat.enabled,
      badges: [
        badge(chat.kind, KIND_STYLE[chat.kind]),
        ...(stale ? [badge(chat.botId ? "other bot" : "no bot", "bg-amber-50 text-amber-700 ring-amber-200")] : []),
      ],
      summary: () => chat.home
        ? h("span", "min-w-0 truncate text-[12px] text-neutral-400", "The conversation · model and reasoning from its ⋯ menu")
        : launchSummary(chat, parent),
      trailing: enabled,
    }, () => chatBody(cfg, chat, stale, parent, () => row.repaint()));
    return row.el;
  }

  function chatBody(cfg: ChannelConfig, chat: ChatConfig, stale: boolean, parent: Launch, repaint: () => void): HTMLElement[] {
    const remove = btn("Remove", "cursor-pointer text-[12px] text-neutral-500 hover:text-red-600 pointer-coarse:min-h-11");
    remove.onclick = async () => {
      const name = chat.name || chat.id;
      if (!window.confirm(`Remove ${name}? Threads in it lose their sessions; a chat the bot can still reach comes back on its next message.`)) return;
      await fetch(`/api/channels/${platform}/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      expanded.delete(`chat:${chat.id}`);
      await load();
    };
    const out: HTMLElement[] = [];
    const switches = h("div", "flex flex-wrap items-center gap-x-6 gap-y-2");
    if (chat.kind === "dm") {
      // A DM has two parties: mention is meaningless and bind is not optional.
      // Two switches that cannot move are worse than a sentence saying so.
      switches.append(
        h("span", "text-[13px] text-neutral-400", "Direct message · bound users only, mention not applicable"),
        // One home instance-wide: the server clears the other platform's row.
        toggle("This DM is the conversation", "", chat.home === true, set((v) => {
          for (const c of cfg.chats) delete c.home;
          if (v) chat.home = true;
          render();
        })),
      );
    } else {
      switches.append(
        toggle("Require mention", "", chat.requireMention, set((v) => (chat.requireMention = v))),
        toggle("Require bind", "", chat.requireBind, set((v) => (chat.requireBind = v))),
      );
    }
    out.push(switches);
    if (stale) {
      out.push(h(
        "span",
        "text-[12.5px] text-amber-700",
        chat.botId
          ? `Stale: last seen under bot ${chat.botId}${cfg.botId ? `, not the current ${cfg.botId}` : ""} — a message here makes it current again.`
          : "Stale: no message since Pier started recording bot identities — a message here makes it current again.",
      ));
    }
    if (chat.home) {
      out.push(rowActions(null, remove, chat.id));
      return out;
    }
    // Empty follows the platform's, so clearing the field is the reset.
    const cwd = dirInput(chat.cwd, followsCwd(cfg), set((v) => {
      chat.cwd = v;
      repaint();
    }));
    cwdFollowers.push(cwd.input);
    out.push(
      h(
        "div",
        "grid grid-cols-1 gap-3 sm:grid-cols-2",
        field("Working directory", cwd.el),
        launchField("Model & reasoning", chat, models, set((next) => {
          chat.model = next.model;
          chat.thinking = next.thinking;
          render();
        }), { model: parent.model, thinking: parent.thinking }),
      ),
      rowActions(chat.cwd || chat.model || chat.thinking ? () => {
        chat.cwd = "";
        chat.model = null;
        chat.thinking = null;
        queueSave();
        render();
      } : null, remove, chat.id),
    );
    return out;
  }

  function chats(cfg: ChannelConfig): HTMLElement {
    // What a field left on Default resolves to, one level up.
    const settings: Launch = { cwd: workspace, ...settingsDefault };
    const platformLaunch: Launch = {
      cwd: cfg.cwd || settings.cwd,
      model: cfg.model ?? settings.model,
      thinking: cfg.thinking ?? settings.thinking,
    };
    const list = h("div", "flex flex-col gap-2", platformRow(cfg, settings));
    if (cfg.chats.length) list.append(...cfg.chats.map((chat) => chatRow(cfg, chat, platformLaunch)));
    else list.append(empty("None yet. Chats appear here after the bot sees a message in them."));
    const stale = cfg.chats.filter((chat) => isStale(cfg, chat) && !chat.home).length;
    const clear = button(`Clear stale (${String(stale)})`);
    clear.onclick = async () => {
      if (!window.confirm(`Remove ${String(stale)} stale ${stale === 1 ? "chat" : "chats"}? Threads in them lose their sessions; a chat the bot can still reach comes back on its next message.`)) return;
      const res = await fetch(`/api/channels/${platform}/clear-stale`, { method: "POST" });
      if (!res.ok) showStatus("failed");
      await load();
    };
    return card(
      platform === "slack" ? "Channels" : "Chats",
      cfg.botId ? `${CHATS_NOTE} Current bot: ${cfg.botId}.` : CHATS_NOTE,
      list,
      ...(stale ? [h("div", "flex", clear)] : []),
    );
  }

  function render(): void {
    if (!config) return;
    renderTabs();
    cwdFollowers = [];
    const column = h("div", "mx-auto flex max-w-3xl flex-col gap-4");
    column.append(connection(config), users(config), chats(config));
    pane.replaceChildren(column);
  }

  return consoleView(
    root,
    () => void load(),
    // Leaving the page must not discard a debounced edit.
    () => {
      if (saveTimer) flush();
    },
  );
}
