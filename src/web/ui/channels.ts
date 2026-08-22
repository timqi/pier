// Console → Channels view: one tab per IM platform, and everything that
// platform needs on that one tab — token, global defaults, bound users,
// discovered chats with their per-chat overrides. A pure consumer of
// /api/channels/:platform.

import type { ModelRef } from "../../core/types.js";
import type { ChannelConfig, ChannelPlatform, ChatConfig, ChatKind } from "../../channels/types.js";
import { sendJson } from "./api.js";
import {
  slackAgentToolHelp,
  slackThreadHelp,
  slackTokenHelp,
  telegramTokenHelp,
  topicModeHelp,
} from "./channel-help.js";
import { dirInput } from "./dir-picker.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { badge, btn, button, card, empty, field, textInput, toggle } from "./form.js";
import { launchField } from "./model-picker.js";

type Loaded = ChannelConfig & { supported: boolean };

const PLATFORMS: [ChannelPlatform, string][] = [["telegram", "Telegram"], ["slack", "Slack"], ["lark", "Lark"]];

/** A switch that cannot move, replaced by the sentence saying why. */
const noteLine = (text: string, help: HTMLElement): HTMLElement =>
  h("span", "flex items-center gap-1.5 text-[13px] text-neutral-400", h("span", "", text), help);

const KIND_STYLE: Record<ChatKind, string> = {
  dm: "bg-sky-50 text-sky-700 ring-sky-200",
  group: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  forum: "bg-violet-50 text-violet-700 ring-violet-200",
};

// --- view ---------------------------------------------------------------------

export function createChannelsView(root: HTMLElement): ConsoleView {
  let platform: ChannelPlatform = "telegram";
  let config: Loaded | null = null;
  let models: ModelRef[] = [];

  // Header and tabs live *inside* the scroll container as sticky rows rather
  // than as flex-none siblings above it: a settings page long enough to scroll
  // is exactly when you still want to see which platform you are editing.
  // The mobile top bar already names the view; the status box stays, so the
  // header keeps its h-10 and the tabs' top-10 offset still lines up.
  const statusBox = h("div", "ml-auto flex items-center gap-1.5 text-[11.5px]");
  const header = h(
    "header",
    "sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-neutral-200 bg-white px-4",
    h("span", "font-medium max-md:hidden", "Channels"),
    statusBox,
  );

  // top-10 == the header's h-10, so the two stack instead of overlapping.
  const tabs = h("div", "sticky top-10 z-30 flex items-center gap-1 border-b border-neutral-200 bg-white px-4 py-2");
  const pane = h("div", "px-4 py-5");
  root.append(h("div", "min-h-0 flex-1 overflow-y-auto", header, tabs, pane));

  function renderTabs(): void {
    tabs.replaceChildren(
      ...PLATFORMS.map(([id, label]) => {
        const active = id === platform;
        const tab = btn(
          "",
          `flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors ${
            active ? "bg-indigo-50 font-medium text-indigo-700" : "text-neutral-600 hover:bg-neutral-100"
          }`,
        );
        // The dot answers "is this one live?" without opening the tab.
        const live = active && config ? config.enabled && !!config.token : false;
        tab.append(h("span", `h-1.5 w-1.5 flex-none rounded-full ${live ? "bg-emerald-500" : "bg-neutral-300"}`), h("span", "", label));
        tab.onclick = () => {
          if (saveTimer) flush();
          platform = id;
          void load();
        };
        return tab;
      }),
    );
  }

  // --- autosave ----------------------------------------------------------------
  // Every control writes straight into `config` and asks for a save. Text
  // fields are debounced so a keystroke is not a request; switches and picks
  // land on the next tick. Saves are serialized and coalesced — `config` is
  // mutated in place, so a save that waits for the one in flight sends the
  // latest state, and two rapid edits collapse into one PUT.
  const SAVE_DEBOUNCE_MS = 500;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  /** The save that has to run once the in-flight one lands. */
  let pending: { platform: ChannelPlatform; config: Loaded } | null = null;

  function showStatus(state: "clean" | "saving" | "saved" | "failed"): void {
    statusBox.replaceChildren();
    if (state === "clean") return;
    const tone = state === "saving" ? "text-neutral-400" : state === "saved" ? "text-emerald-600" : "text-red-600";
    statusBox.className = `ml-auto flex items-center gap-1.5 text-[11.5px] ${tone}`;
    if (state === "saving") {
      statusBox.append(h("span", "spinner"), h("span", "", "Saving…"));
    } else if (state === "saved") {
      statusBox.append(h("span", "", "✓"), h("span", "", "Saved"));
      // Fade the receipt: a permanent "Saved" says nothing about the next edit.
      setTimeout(() => {
        if (statusBox.textContent?.includes("Saved")) showStatus("clean");
      }, 2000);
    } else {
      const retry = btn("Retry", "cursor-pointer underline");
      retry.onclick = flush;
      statusBox.append(h("span", "", "⚠"), h("span", "", "Save failed"), retry);
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

  /**
   * Send one document. The platform travels with it: a save deferred behind an
   * in-flight one must not land on whichever tab the user opened meanwhile.
   * The config object is shared and mutable on purpose — a deferred save picks
   * up every edit made while it waited, which is what collapses a burst of
   * switch flips into a single request.
   */
  async function send(target: { platform: ChannelPlatform; config: Loaded }): Promise<void> {
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
    // Catalogue once per view visit; it does not change while the page is open.
    if (!models.length) {
      const list = await fetch("/api/models");
      if (list.ok) models = (await list.json()) as ModelRef[];
    }
    const res = await fetch(`/api/channels/${platform}`);
    if (!res.ok) {
      config = null;
      renderTabs();
      pane.replaceChildren(empty(`Failed to load: ${res.status}`));
      return;
    }
    config = (await res.json()) as Loaded;
    showStatus("clean");
    render();
  }

  // --- cards -------------------------------------------------------------------

  function connection(cfg: Loaded): HTMLElement {
    const slack = platform === "slack";
    const token = textInput(cfg.token, slack ? "xoxb-…" : "123456789:AA…", set((v) => (cfg.token = v)), true);
    // Slack authenticates its event socket separately from its Web API, so the
    // adapter needs both credentials before it can start.
    const appToken = textInput(cfg.appToken, "xapp-…", set((v) => (cfg.appToken = v)), true);
    const cwd = dirInput(cfg.cwd, "(pier process cwd)", set((v) => (cfg.cwd = v)));
    return card(
      "Connection",
      slack
        ? "Pier connects over Socket Mode; no public URL or webhook needed."
        : "Pier polls Telegram for updates; no public URL or webhook needed.",
      toggle("Enabled", "Start the adapter when Pier boots.", cfg.enabled, set((v) => {
        cfg.enabled = v;
        renderTabs();
      })),
      field("Bot token", token, {
        hint: "Stored locally, shown masked once saved.",
        help: platform === "telegram" ? telegramTokenHelp() : slack ? slackTokenHelp() : undefined,
      }),
      ...(slack
        ? [
          field("App-level token", appToken, { hint: "Opens the Socket Mode connection. Needs connections:write." }),
          toggle(
            "Agent access",
            "Let agent sessions read channel history and post through the slack tool. Off makes the tool refuse; inbound messages are unaffected.",
            cfg.agentTool,
            set((v) => (cfg.agentTool = v)),
            slackAgentToolHelp(),
          ),
        ]
        : []),
      field("Default working directory", cwd.el, { hint: "Where sessions this channel opens start." }),
    );
  }

  function defaults(cfg: Loaded): HTMLElement {
    return card(
      "Defaults for new chats",
      "Copied into a group the first time the bot sees it; changing them here never touches a group that already exists. DMs are always bound-users-only.",
      toggle("Require mention in groups", "Ignore group messages that do not @mention or reply to the bot.", cfg.requireMention, set((v) => (cfg.requireMention = v))),
      toggle("Require bound user", "Only users bound with a code below can drive the agent.", cfg.requireBind, set((v) => (cfg.requireBind = v))),
      // Slack has no equivalent switch: a thread per request is the only
      // behaviour, so the toggle is replaced by the explanation.
      ...(platform === "slack"
        ? [noteLine("Thread mode: always on", slackThreadHelp())]
        : [
          toggle("Topic mode", "In a forum group, each new request opens its own topic and its own session.", cfg.topicMode, set((v) => (cfg.topicMode = v)), topicModeHelp()),
        ]),
      launchField("Model & reasoning", cfg, models, set((next) => {
        cfg.model = next.model;
        cfg.thinking = next.thinking;
        render();
      })),
    );
  }

  function users(cfg: Loaded): HTMLElement {
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
      const remove = btn("Remove", "cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100");
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

  function chatRow(cfg: Loaded, chat: ChatConfig): HTMLElement {
    const box = h("div", `rounded-xl border px-3.5 py-3 transition-colors ${chat.enabled ? "border-neutral-200 bg-white" : "border-neutral-200 bg-neutral-50/60"}`);
    const head = h(
      "div",
      "flex items-center gap-2",
      h("span", `min-w-0 flex-1 truncate text-[13px] font-medium ${chat.enabled ? "text-neutral-800" : "text-neutral-400"}`, chat.name || chat.id),
      badge(chat.kind, KIND_STYLE[chat.kind]),
      h("span", "flex-none font-mono text-[11px] text-neutral-400", chat.id),
    );
    const enabled = toggle("", "", chat.enabled, set((v) => {
      chat.enabled = v;
      render();
    }));
    enabled.classList.add("flex-none", "items-center");
    head.append(enabled);

    const switches = h("div", "mt-3 flex flex-wrap items-center gap-x-6 gap-y-2");
    if (chat.kind === "dm") {
      // A DM has two parties: mention is meaningless, bind is not optional, and
      // topics do not exist. Three switches that cannot move are worse than a
      // sentence saying so.
      switches.append(h("span", "text-[13px] text-neutral-400", platform === "slack"
        ? "Direct message · bound users only, mention not applicable"
        : "Direct message · bound users only, mention and topics not applicable"));
    } else {
      switches.append(
        toggle("Require mention", "", chat.requireMention, set((v) => (chat.requireMention = v))),
        toggle("Require bind", "", chat.requireBind, set((v) => (chat.requireBind = v))),
        // Slack threads every reply unconditionally; on Telegram only a forum
        // has topics, and a plain group gets the "how do I?" help instead of a
        // switch that would do nothing.
        platform === "slack"
          ? noteLine("Thread mode: always on", slackThreadHelp("right"))
          : chat.kind === "forum"
          ? toggle("Topic mode", "", chat.topicMode, set((v) => (chat.topicMode = v)), topicModeHelp("right"))
          : noteLine("Topic mode: forum groups only", topicModeHelp("right")),
      );
    }

    const cwd = dirInput(chat.cwd, "", set((v) => (chat.cwd = v)));
    const grid = h(
      "div",
      "mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2",
      field("Working directory", cwd.el),
      launchField("Model & reasoning", chat, models, set((next) => {
        chat.model = next.model;
        chat.thinking = next.thinking;
        render();
      })),
    );
    box.append(head, switches, grid);
    return box;
  }

  function chats(cfg: Loaded): HTMLElement {
    const list = h("div", "flex flex-col gap-2.5");
    if (cfg.chats.length) list.append(...cfg.chats.map((chat) => chatRow(cfg, chat)));
    else list.append(empty("None yet. Chats appear here after the bot sees a message in them."));
    return card(
      platform === "slack" ? "Channels" : "Chats",
      "Discovered from inbound traffic — no platform reliably lists every chat a bot is in.",
      list,
    );
  }

  function render(): void {
    if (!config) return;
    renderTabs();
    if (!config.supported) {
      pane.replaceChildren(
        empty(`${PLATFORMS.find(([id]) => id === platform)?.[1]} is planned — no adapter yet.`),
      );
      return;
    }
    const column = h("div", "mx-auto flex max-w-3xl flex-col gap-4");
    column.append(connection(config), defaults(config), users(config), chats(config));
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
