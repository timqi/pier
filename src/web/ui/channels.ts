// Console → Channels view: one tab per IM platform, and everything that
// platform needs on that one tab — token, global defaults, bound users,
// discovered chats with their per-chat overrides. A pure consumer of
// /api/channels/:platform.

import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import type { ChannelConfig, ChannelPlatform, ChatConfig, ChatKind } from "../../channels/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { dirInput } from "./dir-picker.js";
import { h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";

type Loaded = ChannelConfig & { supported: boolean };

const PLATFORMS: { id: ChannelPlatform; label: string }[] = [
  { id: "telegram", label: "Telegram" },
  { id: "slack", label: "Slack" },
  { id: "lark", label: "Lark" },
];

export interface ChannelsView {
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

// --- primitives ---------------------------------------------------------------
// Kept local: these are the shapes a settings page needs (cards, switches,
// tri-state segments) and no other view has asked for them yet.

const LABEL = "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400";

const btn = (label: string, cls = ""): HTMLButtonElement => {
  const el = h("button", cls, label) as HTMLButtonElement;
  el.type = "button";
  return el;
};

/** A titled panel. The subtitle carries the "why", so fields need fewer words. */
// No overflow-hidden: help bubbles escape their card, so the header rounds its
// own top corners instead of being clipped into shape by the section.
function card(title: string, subtitle: string, ...body: HTMLElement[]): HTMLElement {
  const el = h("section", "rounded-xl border border-neutral-200 bg-white");
  const head = h("div", "rounded-t-xl border-b border-neutral-200/70 bg-neutral-50/70 px-4 py-2.5");
  head.append(h("h2", "text-[13px] font-semibold text-neutral-700", title));
  if (subtitle) head.append(h("p", "mt-0.5 text-[11.5px] leading-snug text-neutral-500", subtitle));
  const inner = h("div", "flex flex-col gap-4 px-4 py-3.5");
  inner.append(...body);
  el.append(head, inner);
  return el;
}

function field(label: string, control: HTMLElement, hint?: string, help?: HTMLElement): HTMLElement {
  const box = h("div", "flex flex-col gap-1.5");
  const head = h("div", "flex items-center gap-1.5");
  head.append(h("span", LABEL, label));
  if (help) head.append(help);
  box.append(head, control);
  if (hint) box.append(h("span", "text-[11.5px] leading-snug text-neutral-400", hint));
  return box;
}

const textInput = (value: string, placeholder: string, onInput: (v: string) => void, mono = false): HTMLInputElement => {
  const el = document.createElement("input");
  el.className = `w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[12.5px] transition-colors placeholder:text-neutral-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none${
    mono ? " font-mono" : ""
  }`;
  el.value = value;
  el.placeholder = placeholder;
  el.oninput = () => onInput(el.value);
  return el;
};

/** iOS-style switch: a checkbox is too small a target for a security toggle. */
function toggle(
  label: string,
  hint: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  help?: HTMLElement,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "peer sr-only";
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  const track = h(
    "span",
    "relative h-4 w-7 flex-none rounded-full bg-neutral-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-indigo-600 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-200",
  );
  const row = h("label", `flex cursor-pointer gap-2.5 ${label ? "items-start" : "items-center"}`);
  row.append(input, track);
  if (label) {
    const text = h("span", "flex min-w-0 flex-col");
    const head = h("span", "flex items-center gap-1.5");
    head.append(h("span", "text-[13px] text-neutral-700", label));
    if (help) head.append(help);
    text.append(head);
    if (hint) text.append(h("span", "text-[11.5px] leading-snug text-neutral-400", hint));
    row.append(text);
  }
  return row;
}

export interface LaunchChoice {
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
}

/**
 * Model + reasoning for the sessions a chat opens, reusing the chat composer's
 * picker: same grouping, same search, same starred model+reasoning combos.
 * "Pi default" means passing neither, so a new session starts on whatever the
 * project and Pi would have chosen.
 */
function launchField(
  label: string,
  choice: LaunchChoice,
  models: ModelRef[],
  onChange: (next: LaunchChoice) => void,
): HTMLElement {
  const summary = choice.model
    ? `${choice.model.id}${choice.thinking ? ` · ${thinkingLabel(choice.thinking)}` : ""}`
    : choice.thinking
    ? `Pi default · ${thinkingLabel(choice.thinking)}`
    : "Pi default";
  const open = btn(
    summary,
    `flex w-full cursor-pointer items-center gap-1.5 truncate rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-left text-[12.5px] hover:bg-neutral-50 ${
      choice.model ? "text-neutral-700" : "text-neutral-400"
    }`,
  );
  open.title = choice.model ? `${choice.model.provider}/${choice.model.id}` : "Whatever the project and Pi pick";
  open.onclick = () => {
    const panel = modelPicker({
      models,
      current: choice.model,
      // Unset reads as Medium in the selector; it is only written once the
      // user actually picks one, so "Pi default" survives choosing a model.
      thinkingLevel: choice.thinking ?? "medium",
      // No session to ask for a model's supported subset — this configures a
      // launch, not a live turn — and Pi clamps a level a model cannot do.
      thinkingLevels: [...THINKING_LEVELS],
      // A starred combo carries its own reasoning level; apply both at once.
      onPick: (model, thinking) => {
        closeMenu();
        onChange({ model, thinking: thinking ?? choice.thinking });
      },
      onThinkingPick: (thinking) => onChange({ ...choice, thinking }),
    });
    const clear = btn("Pi default", "w-full cursor-pointer px-3 py-1.5 text-left text-[12.5px] text-neutral-500 hover:bg-neutral-100");
    clear.onclick = () => {
      closeMenu();
      onChange({ model: null, thinking: null });
    };
    const wrap = h("div", "flex flex-col");
    wrap.append(panel, h("div", "border-t border-neutral-200"), clear);
    openPanel(open, wrap);
  };
  return field(label, open);
}

/** Inline code, for the slash commands a setup walkthrough is mostly made of. */
const code = (text: string): HTMLElement =>
  h("code", "rounded bg-neutral-100 px-1 py-px font-mono text-[11.5px] text-neutral-700", text);

function link(href: string, text: string): HTMLElement {
  const a = h("a", "text-indigo-600 underline", text) as HTMLAnchorElement;
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

/**
 * Help bubble that survives the trip to it: the badge and the bubble are one
 * hover group, and the gap between them is the bubble's own transparent
 * padding, so crossing it never leaves the group. Clicking pins it open —
 * a five-step walkthrough is not something to read against a timer.
 */
function helpBadge(
  title: string,
  steps: (string | HTMLElement)[],
  /** Which edge to pin to — "right" for badges living in a narrow column. */
  align: "left" | "right" = "left",
): HTMLElement {
  const wrap = h("span", "group relative inline-flex");
  const badge = btn(
    "?",
    "flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[9px] font-bold text-neutral-400 transition-colors group-hover:border-indigo-400 group-hover:text-indigo-500",
  );
  // pt-1.5 is the bridge; the visible card is the inner element. The width is
  // capped against the viewport so a narrow window cannot push it off-screen.
  const bubble = h(
    "span",
    `absolute ${align === "right" ? "right-0" : "left-0"} top-full z-20 hidden w-[min(27rem,calc(100vw-3rem))] pt-1.5 group-hover:block`,
  );
  const panel = h(
    "span",
    "flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3.5 text-[12px] font-normal normal-case leading-[1.55] tracking-normal text-neutral-600 shadow-xl",
  );
  panel.append(h("span", "text-[12.5px] font-semibold text-neutral-800", title));
  const list = h("ol", "flex list-decimal flex-col gap-1.5 pl-4");
  for (const step of steps) {
    const li = h("li", "marker:text-neutral-400");
    if (typeof step === "string") li.textContent = step;
    else li.append(step);
    list.append(li);
  }
  panel.append(list);
  bubble.append(panel);
  badge.onclick = () => {
    // Pinning keeps it up once the pointer leaves. Swapping the two display
    // classes is enough — group-hover:block still wins over hidden while
    // hovering, so unpinning falls straight back to hover behaviour.
    const pinned = bubble.classList.contains("hidden");
    bubble.classList.toggle("hidden", !pinned);
    bubble.classList.toggle("block", pinned);
    badge.classList.toggle("border-indigo-400", pinned);
    badge.classList.toggle("text-indigo-500", pinned);
  };
  wrap.append(badge, bubble);
  return wrap;
}

/**
 * How to get a Telegram bot token, and the two BotFather switches people
 * always miss. Privacy mode is the single most common reason a bot looks dead
 * in a group, so it is called out rather than buried.
 */
function telegramTokenHelp(): HTMLElement {
  const open = h("span", "");
  open.append("Open ", link("https://t.me/BotFather", "@BotFather"), " in Telegram.");
  const newbot = h("span", "");
  newbot.append("Send ", code("/newbot"), ", pick a display name, then a username ending in ", code("bot"), ".");
  const copy = h("span", "");
  copy.append("Copy the token it prints (", code("123456789:AA…"), ") and paste it here.");
  const privacy = h("span", "");
  privacy.append(
    "Send ",
    code("/setprivacy"),
    " → ",
    code("Disable"),
    " if the bot should see plain group messages. Left enabled it only ever receives mentions, replies and commands — the usual reason a bot looks dead in a group.",
  );
  const groups = h("span", "");
  groups.append("Send ", code("/setjoingroups"), " → ", code("Enable"), ", then add the bot to your group or forum.");
  return helpBadge("Getting a bot token", [open, newbot, copy, privacy, groups]);
}

/**
 * Turning a group into a forum is done in Telegram, not here, and the step
 * everyone misses is the bot's Manage Topics right — without it every topic
 * creation fails and Pier quietly keeps answering in General.
 */
function topicModeHelp(align: "left" | "right" = "left"): HTMLElement {
  const enable = h("span", "");
  enable.append(
    "In Telegram open the group → ",
    code("Edit"),
    " → turn on ",
    code("Topics"),
    ". Owner only; group size no longer matters.",
  );
  const converted = h("span", "");
  converted.append("The group becomes a forum supergroup and the existing chat becomes its ", code("General"), " topic.");
  const rights = h("span", "");
  rights.append(
    "Make the bot an admin with ",
    code("Manage Topics"),
    ". That is the one right topic creation needs — without it Pier logs the failure and answers in General instead.",
  );
  const discover = h("span", "");
  discover.append("Send one message in the group so Pier discovers it, then enable it under ", code("Chats"), " below.");
  const behaviour = h("span", "");
  behaviour.append(
    "After that, a message in General opens its own topic with its own session. A reply, or anything starting with ",
    code("/"),
    ", stays where it was sent.",
  );
  return helpBadge("Enabling topics on a group", [enable, converted, rights, discover, behaviour], align);
}

const KIND_STYLE: Record<ChatKind, string> = {
  dm: "bg-sky-50 text-sky-700 ring-sky-200",
  group: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  forum: "bg-violet-50 text-violet-700 ring-violet-200",
};

const badge = (text: string, cls: string): HTMLElement =>
  h("span", `flex-none rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ring-1 ${cls}`, text);

const empty = (text: string): HTMLElement =>
  h(
    "p",
    "rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-center text-[12.5px] text-neutral-400",
    text,
  );

// --- view ---------------------------------------------------------------------

export function createChannelsView(root: HTMLElement): ChannelsView {
  let platform: ChannelPlatform = "telegram";
  let config: Loaded | null = null;
  let models: ModelRef[] = [];
  let visible = false;

  // Header and tabs live *inside* the scroll container as sticky rows rather
  // than as flex-none siblings above it: a settings page long enough to scroll
  // is exactly when you still want to see which platform you are editing.
  const header = h("header", "sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-neutral-200 bg-white px-4");
  // The mobile top bar already names the view; the status box stays, so the
  // header keeps its h-10 and the tabs' top-10 offset still lines up.
  header.append(h("span", "font-medium max-md:hidden", "Channels"));
  const statusBox = h("div", "ml-auto flex items-center gap-1.5 text-[11.5px]");
  header.append(statusBox);

  // top-10 == the header's h-10, so the two stack instead of overlapping.
  const tabs = h("div", "sticky top-10 z-30 flex items-center gap-1 border-b border-neutral-200 bg-white px-4 py-2");
  const pane = h("div", "px-4 py-5");
  const scroll = h("div", "min-h-0 flex-1 overflow-y-auto");
  scroll.append(header, tabs, pane);
  root.append(scroll);

  function renderTabs(): void {
    tabs.replaceChildren(
      ...PLATFORMS.map(({ id, label }) => {
        const active = id === platform;
        const tab = btn(
          "",
          `flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors ${
            active ? "bg-indigo-50 font-medium text-indigo-700" : "text-neutral-600 hover:bg-neutral-100"
          }`,
        );
        // The dot answers "is this one live?" without opening the tab.
        const live = active && config ? config.enabled && !!config.token : false;
        tab.append(
          h("span", `h-1.5 w-1.5 flex-none rounded-full ${live ? "bg-emerald-500" : "bg-neutral-300"}`),
          h("span", "", label),
        );
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
    if (state === "saving") {
      statusBox.className = "ml-auto flex items-center gap-1.5 text-[11.5px] text-neutral-400";
      statusBox.append(h("span", "spinner"), h("span", "", "Saving…"));
      return;
    }
    if (state === "saved") {
      statusBox.className = "ml-auto flex items-center gap-1.5 text-[11.5px] text-emerald-600";
      statusBox.append(h("span", "", "✓"), h("span", "", "Saved"));
      // Fade the receipt: a permanent "Saved" says nothing about the next edit.
      setTimeout(() => {
        if (statusBox.textContent?.includes("Saved")) showStatus("clean");
      }, 2000);
      return;
    }
    statusBox.className = "ml-auto flex items-center gap-1.5 text-[11.5px] text-red-600";
    const retry = btn("Retry", "cursor-pointer underline");
    retry.onclick = flush;
    statusBox.append(h("span", "", "⚠"), h("span", "", "Save failed"), retry);
  }

  /** Ask for a save. Immediate feedback, deferred request. */
  function queueSave(): void {
    showStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

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
      const res = await fetch(`/api/channels/${target.platform}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target.config),
      });
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
    const token = textInput(cfg.token, "123456789:AA…", (v) => {
      cfg.token = v;
      queueSave();
    }, true);
    const cwd = dirInput(cfg.cwd, "(pier process cwd)", (v) => {
      cfg.cwd = v;
      queueSave();
    });
    return card(
      "Connection",
      "Pier polls Telegram for updates; no public URL or webhook needed.",
      toggle("Enabled", "Start the adapter when Pier boots.", cfg.enabled, (v) => {
        cfg.enabled = v;
        queueSave();
        renderTabs();
      }),
      field("Bot token", token, "Stored locally, shown masked once saved.", platform === "telegram" ? telegramTokenHelp() : undefined),
      field("Default working directory", cwd.el, "Where sessions this channel opens start."),
    );
  }

  function defaults(cfg: Loaded): HTMLElement {
    return card(
      "Defaults for new chats",
      "Copied into a group the first time the bot sees it; changing them here never touches a group that already exists. DMs are always bound-users-only.",
      toggle("Require mention in groups", "Ignore group messages that do not @mention or reply to the bot.", cfg.requireMention, (v) => {
        cfg.requireMention = v;
        queueSave();
      }),
      toggle("Require bound user", "Only users bound with a code below can drive the agent.", cfg.requireBind, (v) => {
        cfg.requireBind = v;
        queueSave();
      }),
      toggle("Topic mode", "In a forum group, each new request opens its own topic and its own session.", cfg.topicMode, (v) => {
        cfg.topicMode = v;
        queueSave();
      }, platform === "telegram" ? topicModeHelp() : undefined),
      launchField("Model & reasoning", cfg, models, (next) => {
        cfg.model = next.model;
        cfg.thinking = next.thinking;
        queueSave();
        render();
      }),
    );
  }

  function users(cfg: Loaded): HTMLElement {
    const codeBox = h("div", "hidden items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-[12.5px] text-indigo-800");
    const codeText = h("span", "font-mono text-[15px] font-semibold tracking-widest");
    codeBox.append(codeText, h("span", "text-[11.5px] text-indigo-500", "DM the bot /bind <code> · expires in 10 min"));
    const issue = btn("Generate bind code", "btn text-[12.5px]");
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
      const row = h("div", "group flex items-center gap-2.5 border-b border-neutral-100 py-2 last:border-0");
      const remove = btn("Remove", "cursor-pointer text-[11.5px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100");
      remove.onclick = async () => {
        await fetch(`/api/channels/${platform}/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
        await load();
      };
      row.append(
        h("span", "flex h-6 w-6 flex-none items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold text-neutral-500", (user.name[0] ?? "?").toUpperCase()),
        h("span", "min-w-0 flex-1 truncate text-[13px] text-neutral-700", user.name),
        h("span", "flex-none font-mono text-[11.5px] text-neutral-400", user.id),
        remove,
      );
      list.append(row);
    }
    const actions = h("div", "flex flex-col gap-2");
    actions.append(issue, codeBox);
    return card("Bound users", "A code is single-use and expires; redeeming it in a DM binds that account.", list, actions);
  }

  function chatRow(cfg: Loaded, chat: ChatConfig): HTMLElement {
    const box = h(
      "div",
      `rounded-xl border px-3.5 py-3 transition-colors ${chat.enabled ? "border-neutral-200 bg-white" : "border-neutral-200 bg-neutral-50/60"}`,
    );
    const head = h("div", "flex items-center gap-2");
    head.append(
      h("span", `min-w-0 flex-1 truncate text-[13px] font-medium ${chat.enabled ? "text-neutral-800" : "text-neutral-400"}`, chat.name || chat.id),
      badge(chat.kind, KIND_STYLE[chat.kind]),
      h("span", "flex-none font-mono text-[11px] text-neutral-400", chat.id),
    );
    const enabled = toggle("", "", chat.enabled, (v) => {
      chat.enabled = v;
      queueSave();
      render();
    });
    enabled.classList.add("flex-none", "items-center");
    head.append(enabled);

    const switches = h("div", "mt-3 flex flex-wrap items-center gap-x-6 gap-y-2");
    if (chat.kind === "dm") {
      // A DM has two parties: mention is meaningless, bind is not optional, and
      // topics do not exist. Three switches that cannot move are worse than a
      // sentence saying so.
      switches.append(h(
        "span",
        "text-[13px] text-neutral-400",
        "Direct message · bound users only, mention and topics not applicable",
      ));
    } else {
      switches.append(
        toggle("Require mention", "", chat.requireMention, (v) => {
          chat.requireMention = v;
          queueSave();
        }),
        toggle("Require bind", "", chat.requireBind, (v) => {
          chat.requireBind = v;
          queueSave();
        }),
        // Only forums have topics; a plain group gets the "how do I?" help
        // instead of a switch that would do nothing.
        chat.kind === "forum"
          ? toggle("Topic mode", "", chat.topicMode, (v) => {
            chat.topicMode = v;
            queueSave();
          }, topicModeHelp("right"))
          : (() => {
            const off = h("span", "flex items-center gap-1.5 text-[13px] text-neutral-400");
            off.append(h("span", "", "Topic mode: forum groups only"), topicModeHelp("right"));
            return off;
          })(),
      );
    }

    const cwd = dirInput(chat.cwd, "", (v) => {
      chat.cwd = v;
      queueSave();
    });
    const grid = h("div", "mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2");
    grid.append(
      field("Working directory", cwd.el),
      launchField("Model & reasoning", chat, models, (next) => {
        chat.model = next.model;
        chat.thinking = next.thinking;
        queueSave();
        render();
      }),
    );
    box.append(head, switches, grid);
    return box;
  }

  function chats(cfg: Loaded): HTMLElement {
    const list = h("div", "flex flex-col gap-2.5");
    if (cfg.chats.length) list.append(...cfg.chats.map((chat) => chatRow(cfg, chat)));
    else list.append(empty("None yet. Chats appear here after the bot sees a message in them."));
    return card(
      "Chats",
      "Discovered from inbound traffic — Telegram has no API to list them.",
      list,
    );
  }

  function render(): void {
    if (!config) return;
    renderTabs();
    if (!config.supported) {
      pane.replaceChildren(
        empty(`${PLATFORMS.find((p) => p.id === platform)?.label} is planned — no adapter yet.`),
      );
      return;
    }
    const column = h("div", "mx-auto flex max-w-3xl flex-col gap-4");
    column.append(connection(config), defaults(config), users(config), chats(config));
    pane.replaceChildren(column);
  }

  return {
    show() {
      visible = true;
      root.classList.remove("hidden");
      root.classList.add("flex");
      void load();
    },
    hide() {
      // Leaving the page must not discard a debounced edit.
      if (saveTimer) flush();
      visible = false;
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
    get visible() {
      return visible;
    },
  };
}
