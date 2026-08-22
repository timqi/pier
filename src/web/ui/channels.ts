// Console → Channels view: one tab per IM platform, and everything that
// platform needs on that one tab — token, global defaults, bound users,
// discovered chats with their per-chat overrides. A pure consumer of
// /api/channels/:platform.

import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "../../core/types.js";
import type { ChannelConfig, ChannelPlatform, ChatConfig, ChatKind } from "../../channels/types.js";
import { thinkingLabel } from "../../core/reply.js";
import { copyBtn } from "./chat.js";
import { dirInput } from "./dir-picker.js";
import { h } from "./dom.js";
import {
  badge,
  btn,
  button,
  card,
  CONTROL,
  empty,
  field,
  helpBadge,
  textInput,
  toggle,
  withControl,
} from "./form.js";
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
  // Not a button: a dropdown trigger that must read as the input beside it, so
  // it wears the shared control skin rather than a copy of it.
  const open = btn(
    summary,
    `${CONTROL} flex cursor-pointer items-center gap-1.5 truncate text-left hover:bg-neutral-50 ${
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

/**
 * Everything Pier's Slack adapter needs, as an app manifest.
 *
 * This is the copy-paste path: Slack's "From an app manifest" flow sets every
 * scope, every event subscription, Socket Mode and interactivity in one go, so
 * nobody has to tick eighteen checkboxes across four pages and discover the
 * missing one from a runtime error.
 *
 * Least privilege, and each entry is here because a specific call needs it:
 *  - no `app_mentions:read` — the `app_mention` event duplicates
 *    `message.channels` with its own event_id, so the adapter ignores it and
 *    the scope would be dead weight.
 *  - no `reactions:read` — receipts only ever add and remove, never read.
 *  - no `commands` — commands are bare words, not slash commands.
 *  - no `files:write` — Pier reads inbound images and uploads nothing.
 */
const SLACK_MANIFEST = {
  display_information: {
    name: "Pier",
    description: "Coding agent sessions in Slack threads",
    background_color: "#262626",
  },
  features: {
    bot_user: { display_name: "Pier", always_online: false },
    // A DM is the only place binding works, so the Messages tab has to be on.
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        "chat:write", // post every reply
        "reactions:write", // the 👀 receipt, added and removed
        "channels:history", // read messages in public channels
        "channels:read", // conversations.info, for the Console's channel list
        "groups:history", // the same two, for private channels
        "groups:read",
        "im:history", // DMs, where binding happens
        "im:write",
        // Group DMs, which the adapter treats as DMs. `mpim:read` is for the
        // one path that cannot shortcut: a button click carries no
        // channel_type, and an mpim id is not `D`-prefixed, so resolving its
        // kind needs conversations.info. (No `im:read`: a `D` id is a DM by
        // construction, so a 1:1 DM never needs the lookup.)
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read", // users.info, to name a bound user
        "files:read", // download inbound images
      ],
    },
  },
  settings: {
    event_subscriptions: {
      // No app_mention: see above.
      bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
    },
    // Buttons and the working-directory modal both need this.
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

/** Slack prefills the create-app form from this query parameter. */
const slackManifestUrl = (): string =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${
    encodeURIComponent(JSON.stringify(SLACK_MANIFEST))
  }`;

/**
 * How to get a Telegram bot token, and the two BotFather switches people
 * always miss. Privacy mode is the single most common reason a bot looks dead
 * in a group, so it is called out rather than buried.
 */
const telegramTokenHelp = (): HTMLElement =>
  helpBadge("Getting a bot token", [
    "Open [@BotFather](https://t.me/BotFather) in Telegram.",
    "Send `/newbot`, pick a display name, then a username ending in `bot`.",
    "Copy the token it prints (`123456789:AA…`) and paste it here.",
    "Send `/setprivacy` → `Disable` if the bot should see plain group messages. Left enabled it only ever receives mentions, replies and commands — the usual reason a bot looks dead in a group.",
    "Send `/setjoingroups` → `Enable`, then add the bot to your group or forum.",
  ]);

/**
 * Turning a group into a forum is done in Telegram, not here, and the step
 * everyone misses is the bot's Manage Topics right — without it every topic
 * creation fails and Pier quietly keeps answering in General.
 */
const topicModeHelp = (align: "left" | "right" = "left"): HTMLElement =>
  helpBadge("Enabling topics on a group", [
    "In Telegram open the group → `Edit` → turn on `Topics`. Owner only; group size no longer matters.",
    "The group becomes a forum supergroup and the existing chat becomes its `General` topic.",
    "Make the bot an admin with `Manage Topics`. That is the one right topic creation needs — without it Pier logs the failure and answers in General instead.",
    "Send one message in the group so Pier discovers it, then enable it under `Chats` below.",
    "After that, a message in General opens its own topic with its own session. A reply, or anything starting with `/`, stays where it was sent.",
  ], align);

/**
 * Slack setup is a manifest, not a checklist: the button hands Slack every
 * scope and event at once, so the prose covers only what a manifest cannot do.
 */
function slackTokenHelp(): HTMLElement {
  const openApp = button("Create Slack app ↗", true);
  openApp.classList.add("mt-1", "w-fit");
  openApp.onclick = () => window.open(slackManifestUrl(), "_blank", "noreferrer");
  const copyManifest = copyBtn("btn w-fit text-[12.5px]", () => JSON.stringify(SLACK_MANIFEST, null, 2));
  return helpBadge("Creating a Slack app", [
    withControl(
      "Opens Slack with every scope, event and Socket Mode already filled in. Pick your workspace → Create.",
      openApp,
    ),
    "`Install to Workspace` → allow. Then `OAuth & Permissions` → copy the bot token (`xoxb-…`) into the field above.",
    // The one thing the manifest cannot do, and the step people miss precisely
    // because Socket Mode is already switched on.
    "`Basic Information` → `App-Level Tokens` → `Generate` with scope `connections:write`. Paste that `xapp-…` token below. The manifest cannot mint this one for you.",
    "In Slack, invite the bot where you want it: `/invite @Pier`. It answers in threads only, so it never adds noise to the channel.",
    withControl("Prefer to paste it yourself? Create the app from a manifest and use this:", copyManifest),
  ]);
}

/**
 * What "Agent access" grants. Worth spelling out: it is the one switch that
 * lets a session reach outward into the workspace rather than only answer what
 * was sent to it.
 */
const slackAgentToolHelp = (): HTMLElement =>
  helpBadge("What agent access allows", [
    "Gives agent sessions a `slack` tool: read a channel's history for a time range, read one thread, and post a message.",
    "Pier performs every call itself — the bot token is never given to the agent, and Slack's own membership rules still apply, so the bot reaches only channels it was invited to.",
    "Reads are answered from Pier's local cache where possible; only a range that has never been fetched goes to Slack.",
    "This includes sessions started by tasks and subagents. Switch it off if an agent should never post to your workspace on its own.",
  ]);

/**
 * Threads are not optional on Slack, so this explains the behaviour instead of
 * offering a switch. Said once here rather than implied by a missing toggle.
 */
const slackThreadHelp = (align: "left" | "right" = "left"): HTMLElement =>
  helpBadge("How Slack threads work here", [
    "Pier never posts in a channel's main flow. A message in the channel is answered in *its own thread*; a message in a thread is answered in that thread.",
    "Each thread is its own Pi session, so one channel hosts many parallel sessions.",
    "The same applies in a DM: every new message you send there starts its own thread and its own session. Reply *inside* a thread to continue that conversation.",
    "Inside a thread Pier already owns, no `@mention` is needed — continuing that thread is addressing it.",
    "Commands are bare words after a mention: `@bot settings`, `@bot stop`, `@bot bind <code>`. Slack's client swallows an unregistered `/command` before it ever reaches an app.",
  ], align);

const KIND_STYLE: Record<ChatKind, string> = {
  dm: "bg-sky-50 text-sky-700 ring-sky-200",
  group: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  forum: "bg-violet-50 text-violet-700 ring-violet-200",
};

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
    const slack = platform === "slack";
    const token = textInput(cfg.token, slack ? "xoxb-…" : "123456789:AA…", (v) => {
      cfg.token = v;
      queueSave();
    }, true);
    // Slack authenticates its event socket separately from its Web API, so the
    // adapter needs both credentials before it can start.
    const appToken = textInput(cfg.appToken, "xapp-…", (v) => {
      cfg.appToken = v;
      queueSave();
    }, true);
    const cwd = dirInput(cfg.cwd, "(pier process cwd)", (v) => {
      cfg.cwd = v;
      queueSave();
    });
    return card(
      "Connection",
      slack
        ? "Pier connects over Socket Mode; no public URL or webhook needed."
        : "Pier polls Telegram for updates; no public URL or webhook needed.",
      toggle("Enabled", "Start the adapter when Pier boots.", cfg.enabled, (v) => {
        cfg.enabled = v;
        queueSave();
        renderTabs();
      }),
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
            (v) => {
              cfg.agentTool = v;
              queueSave();
            },
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
      toggle("Require mention in groups", "Ignore group messages that do not @mention or reply to the bot.", cfg.requireMention, (v) => {
        cfg.requireMention = v;
        queueSave();
      }),
      toggle("Require bound user", "Only users bound with a code below can drive the agent.", cfg.requireBind, (v) => {
        cfg.requireBind = v;
        queueSave();
      }),
      // Slack has no equivalent switch: a thread per request is the only
      // behaviour, so the toggle is replaced by the explanation.
      ...(platform === "slack"
        ? [(() => {
          const line = h("div", "flex items-center gap-1.5 text-[13px] text-neutral-400");
          line.append(h("span", "", "Thread mode: always on"), slackThreadHelp());
          return line;
        })()]
        : [
          toggle("Topic mode", "In a forum group, each new request opens its own topic and its own session.", cfg.topicMode, (v) => {
            cfg.topicMode = v;
            queueSave();
          }, topicModeHelp()),
        ]),
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
        platform === "slack"
          ? "Direct message · bound users only, mention not applicable"
          : "Direct message · bound users only, mention and topics not applicable",
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
        // Slack threads every reply unconditionally; on Telegram only a forum
        // has topics, and a plain group gets the "how do I?" help instead of a
        // switch that would do nothing.
        platform === "slack"
          ? (() => {
            const on = h("span", "flex items-center gap-1.5 text-[13px] text-neutral-400");
            on.append(h("span", "", "Thread mode: always on"), slackThreadHelp("right"));
            return on;
          })()
          : chat.kind === "forum"
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
