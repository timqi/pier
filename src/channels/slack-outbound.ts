// How a turn becomes messages in a Slack thread.
//
// Split out of the adapter because it is a separate decision from routing
// inbound traffic: which renderer to use, how to chunk against that renderer's
// limit, and what an empty turn still has to say. The adapter keeps the 👀
// receipts, because those are about the turn ending, not about what was said.

import type { AgentReply, SystemInputOrigin, TurnMeta } from "../core/types.js";
import { formatTurnMeta, isSilentReply, originLabel, quietLabel } from "../core/reply.js";
import { sendAttachments, splitAttachments } from "./attach.js";
import { isBlockRejection, type SlackBlock, type SlackClient } from "./slack-api.js";
import {
  actions,
  chunk,
  context,
  escapeMrkdwn,
  markdown,
  MARKDOWN_MAX,
  MRKDWN_MAX,
  sections,
  toMrkdwn,
} from "./slack-render.js";

/**
 * The web shows a turn's cost on hover. Slack has a `context` block — genuinely
 * small, muted text — so unlike Telegram the footer needs no italic hack to
 * read as a footnote.
 */
const footerText = (meta: TurnMeta): string => escapeMrkdwn(formatTurnMeta(meta));

export class SlackOutbound {
  /**
   * Latched off for the process on the first refusal, so the failed round trip
   * is paid once rather than once per message.
   */
  private markdownBlocks = true;

  constructor(
    private readonly api: Pick<SlackClient, "postMessage" | "uploadFile">,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Post one turn, empty text included: the turn settled with nothing to say,
   * and that is still something to show.
   */
  async reply(channel: string, threadTs: string, reply: AgentReply): Promise<void> {
    // A file the agent linked lives on Pier's machine, so the link is dead in
    // Slack: the bytes are uploaded instead and the label stays in the text.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    const footer = reply.meta ? footerText(reply.meta) : "";
    const row = actions(reply.suggestions);
    // A turn that produced no text still posts its footer, and says which kind
    // of nothing it was. Silence must be *observable*: total silence is
    // indistinguishable from a crash, a dropped connection or a bug, and the
    // person waiting has no way to tell. A muted one-liner is the cheapest
    // honest answer.
    const quiet = isSilentReply(reply)
      ? `_${quietLabel(reply.silence && escapeMrkdwn(reply.silence))}_`
      : "";
    if (!(text || row || footer || quiet || paths.length)) return;
    const parts = text ? chunk(text, this.budget()) : [""];
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      // The footer and the buttons ride the last chunk only. The quiet marker
      // shares the footer's block, so an empty turn is one muted line rather
      // than two.
      const note = last ? [quiet, footer].filter(Boolean).join(" · ") : "";
      await this.post(channel, threadTs, part, [
        ...(note ? [context(note)] : []),
        ...(last && row ? [row] : []),
      ]);
    }
    // Attachments follow the words, so the message introducing them is above
    // them; anything that could not be sent says so in the thread.
    const lost = await sendAttachments(
      paths,
      (file) => this.api.uploadFile(channel, threadTs, file),
      this.log,
    );
    // Unescaped, like every other body: post() escapes on the path that needs it.
    if (lost) await this.post(channel, threadTs, lost, []);
  }

  /**
   * A system note: quoted, labelled with where it came from, and deliberately
   * plain — no buttons and no turn footer, because the turn this input
   * triggers has not ended yet.
   */
  async note(
    channel: string,
    threadTs: string,
    note: { text: string; origin: SystemInputOrigin },
  ): Promise<void> {
    // Markdown's own blockquote, so the note reads as quoted on either path.
    const body = note.text.split("\n").map((line) => `> ${line}`).join("\n");
    for (const part of chunk(`_${originLabel(note.origin)}_\n${body}`, this.budget())) {
      await this.post(channel, threadTs, part, []);
    }
  }

  /** Which budget `chunk()` should respect, given the path we are on. */
  private budget(): number {
    return this.markdownBlocks ? MARKDOWN_MAX : MRKDWN_MAX;
  }

  /**
   * Post one message's body, preferring Slack's own markdown renderer.
   *
   * The `markdown` block takes the agent's markdown unmodified — tables,
   * headers and nested lists all survive, none of which the mrkdwn subset can
   * express — and the client never folds it behind "Show more". It is recent
   * enough to be refused by an older workspace, so a rejection degrades to the
   * translated mrkdwn path instead of losing the turn.
   */
  private async post(
    channel: string,
    threadTs: string,
    body: string,
    trailing: SlackBlock[],
  ): Promise<void> {
    // `text` is the notification and accessibility fallback, never shown
    // beside the blocks.
    const notice = body || trailing.length ? body || "…" : "";
    if (this.markdownBlocks) {
      const blocks = [...(body ? [markdown(body)] : []), ...trailing];
      if (!blocks.length) return;
      try {
        await this.api.postMessage({ channel, thread_ts: threadTs, text: notice, blocks });
        return;
      } catch (err) {
        if (!isBlockRejection(err)) throw err;
        this.markdownBlocks = false;
        this.log(`markdown block refused, falling back to mrkdwn: ${String(err)}`);
      }
    }
    // Legacy path: translate to mrkdwn and split into section blocks. The body
    // was chunked against the larger budget, so it may need splitting again.
    for (const part of body ? chunk(toMrkdwn(body), MRKDWN_MAX) : [""]) {
      const blocks = [...sections(part), ...trailing];
      if (!blocks.length) continue;
      await this.api.postMessage({
        channel,
        thread_ts: threadTs,
        text: part || notice || "…",
        blocks,
      });
    }
  }
}
