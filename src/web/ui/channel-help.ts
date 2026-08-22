// Console → Channels: the setup content — the Slack app manifest and every
// help bubble's walkthrough prose. Pure content with no view state, kept apart
// so channels.ts is the settings page and this file is what it explains.

import { copyBtn } from "./dom.js";
import { button, helpBadge, withControl } from "./form.js";

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
export const telegramTokenHelp = (): HTMLElement =>
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
export const topicModeHelp = (align: "left" | "right" = "left"): HTMLElement =>
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
export function slackTokenHelp(): HTMLElement {
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
export const slackAgentToolHelp = (): HTMLElement =>
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
export const slackThreadHelp = (align: "left" | "right" = "left"): HTMLElement =>
  helpBadge("How Slack threads work here", [
    "Pier never posts in a channel's main flow. A message in the channel is answered in *its own thread*; a message in a thread is answered in that thread.",
    "Each thread is its own Pi session, so one channel hosts many parallel sessions.",
    "The same applies in a DM: every new message you send there starts its own thread and its own session. Reply *inside* a thread to continue that conversation.",
    "Inside a thread Pier already owns, no `@mention` is needed — continuing that thread is addressing it.",
    "Commands are bare words after a mention: `@bot settings`, `@bot stop`, `@bot bind <code>`. Slack's client swallows an unregistered `/command` before it ever reaches an app.",
  ], align);
