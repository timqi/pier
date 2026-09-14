// Settings → Channels: one tab per IM platform, a pure consumer of
// /api/channels/:platform.

import { Check, LoaderCircle, TriangleAlert } from "lucide";
import { icon } from "./icons.js";
import type { ModelRef } from "../../core/types.js";
import type { ChannelConfig, ChannelPlatform, ChatConfig, ChatKind } from "../../channels/types.js";
import { getJson, sendJson } from "./api.js";
import {
  larkThreadHelp,
  larkTokenHelp,
  slackThreadHelp,
  slackTokenHelp,
} from "./channel-help.js";
import { dirInput } from "./dir-picker.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { badge, btn, button, card, empty, field, segmented, STATUS_TONE, textInput, toggle } from "./form.js";
import { launchField } from "./model-picker.js";

const PLATFORMS: [ChannelPlatform, string][] = [["slack", "Slack"], ["lark", "Lark"]];

const KIND_STYLE: Record<ChatKind, string> = {
  dm: "bg-sky-50 text-sky-700 ring-sky-200",
  group: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

// --- view ---------------------------------------------------------------------

const PLATFORM_KEY = "pier.channelsPlatform";

export function createChannelsView(root: HTMLElement): ConsoleView {
  const stored = localStorage.getItem(PLATFORM_KEY);
  let platform: ChannelPlatform = PLATFORMS.some(([id]) => id === stored)
    ? (stored as ChannelPlatform)
    : "slack";
  let config: ChannelConfig | null = null;
  let models: ModelRef[] = [];

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
    // Catalogue once per view visit; it does not change while the page is open.
    if (!models.length) {
      const list = await getJson<ModelRef[]>("/api/models", "Could not load the model catalog");
      if (list.ok) models = list.value;
    }
    const got = await getJson<ChannelConfig>(`/api/channels/${platform}`, "Failed to load");
    if (!got.ok) {
      config = null;
      renderTabs();
      pane.replaceChildren(empty(got.error));
      return;
    }
    config = got.value;
    showStatus("clean");
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
    const cwd = dirInput(cfg.cwd, "(pier process cwd)", set((v) => (cfg.cwd = v)));
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
      field("Default working directory", cwd.el, { hint: "Where sessions this channel opens start." }),
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

  function defaults(cfg: ChannelConfig): HTMLElement {
    return card(
      "Defaults for new chats",
      "Copied into a group the first time the bot sees it; changing them here never touches a group that already exists. DMs are always bound-users-only.",
      toggle("Require mention in groups", "Ignore group messages that do not @mention or reply to the bot.", cfg.requireMention, set((v) => (cfg.requireMention = v))),
      toggle("Require bound user", "Only users bound with a code below can drive the agent.", cfg.requireBind, set((v) => (cfg.requireBind = v))),
      launchField("Model & reasoning", cfg, models, set((next) => {
        cfg.model = next.model;
        cfg.thinking = next.thinking;
        render();
      })),
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
      const remove = btn("Remove", "cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100 pointer-coarse:opacity-100");
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

  function chatRow(cfg: ChannelConfig, chat: ChatConfig): HTMLElement {
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
      // A DM has two parties: mention is meaningless and bind is not optional.
      // Two switches that cannot move are worse than a sentence saying so.
      switches.append(h("span", "text-[13px] text-neutral-400", "Direct message · bound users only, mention not applicable"));
    } else {
      switches.append(
        toggle("Require mention", "", chat.requireMention, set((v) => (chat.requireMention = v))),
        toggle("Require bind", "", chat.requireBind, set((v) => (chat.requireBind = v))),
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

  function chats(cfg: ChannelConfig): HTMLElement {
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
