// Settings → Channels: the setup content — the Slack app manifest and every
// help bubble's walkthrough prose. Pure content with no view state, kept apart
// so channels.ts is the settings page and this file is what it explains.

import { ExternalLink } from "lucide";
import { icon } from "./icons.js";
import { copyBtn } from "./dom.js";
import { button, helpBadge, withControl } from "./form.js";

/** Slack's "From an app manifest" flow sets every scope, event and Socket Mode
 *  in one go. Least privilege: no `app_mentions:read` (the adapter ignores
 *  `app_mention`), no `reactions:read` (receipts never read), no `commands`. */
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
        // `mpim:read`: a button click carries no channel_type and an mpim id is
        // not `D`-prefixed, so its kind needs conversations.info. No `im:read`:
        // a `D` id is a DM by construction.
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read", // users.info, to name a bound user
        "files:read", // download inbound files
        "files:write", // upload a file the agent produced (channels/attach.ts)
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

/** The prose covers only what a manifest cannot do. */
export function slackTokenHelp(): HTMLElement {
  const openApp = button("Create Slack app", true);
  openApp.append(icon(ExternalLink));
  openApp.classList.add("inline-flex", "items-center", "gap-1.5");
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

/** Threads are not optional on Slack; this says what that means for sessions. */
export const slackThreadHelp = (): HTMLElement =>
  helpBadge("How Slack threads work here", [
    "Pier never posts in a channel's main flow. A message in the channel is answered in *its own thread*; a message in a thread is answered in that thread.",
    "Each thread is its own Pi session, so one channel hosts many parallel sessions.",
    "The same applies in a DM: every new message you send there starts its own thread and its own session. Reply *inside* a thread to continue that conversation.",
    "Inside a thread Pier already owns, no `@mention` is needed — continuing that thread is addressing it.",
    "Commands are bare words after a mention: `@bot settings`, `@bot stop`, `@bot bind <code>`. `@bot settings <question>` (or `s`, `set`) drafts a session — directory, model, reasoning — and Start runs the question in it. Slack's client swallows an unregistered `/command` before it ever reaches an app.",
  ]);

/** Feishu has no create-from-config URL, and permissions only take effect
 *  after a version is published — the step everyone misses. */
export const larkTokenHelp = (): HTMLElement =>
  helpBadge("Creating a Feishu app", [
    "On [open.feishu.cn](https://open.feishu.cn/app) create a 企业自建应用 (custom app). `Credentials & Basic Info` shows the App ID (`cli_…`) and App Secret — paste both here.",
    "`Add Features` → enable **Bot** (机器人).",
    "`Permissions` (权限管理), add: `im:message` (read messages), `im:message:send_as_bot` (send), `im:resource` (attachments, both directions), `im:message.reactions:create` + `:read` + `:delete` (the 👀 receipt), `im:chat:readonly` (chat names for this page), `contact:user.base:readonly` (speaker names).",
    "`Events & Callbacks` → set the mode to **长连接 (long connection)** — no public URL needed. Under Events subscribe `im.message.receive_v1` (接收消息); Callbacks gain `card.action.trigger` automatically once cards are sent, add it if listed.",
    "**Publish a version** (版本管理与发布 → 创建版本 → 申请发布). Nothing above takes effect until this is approved — the usual reason a configured bot stays silent.",
    "Add the bot to a group (群设置 → 群机器人), or DM it directly.",
  ]);

/** Topics are not optional on Lark either. */
export const larkThreadHelp = (): HTMLElement =>
  helpBadge("How Lark topics work here", [
    "Pier never posts in a chat's main flow. A message in the chat is answered in *its own topic* (话题); a message inside a topic is answered there.",
    "Each topic is its own Pi session, so one group hosts many parallel sessions.",
    "The same applies in a DM: every new message starts its own topic and its own session. Reply *inside* a topic to continue that conversation.",
    "Inside a topic Pier already owns, no @mention is needed — continuing that topic is addressing it.",
    "Commands are slash words: `/stop`, `/settings`, `/bind <code>`. `/settings <question>` (or `/s`, `/set`) drafts a session — directory, model, reasoning — and Start runs the question in it. A bare @mention with nothing else also opens the settings panel.",
  ]);
