// How a turn becomes messages in a Slack thread, or the home DM's main flow:
// which renderer, how to chunk against its limit, and what an empty turn still has to say.

import type { AgentReply, NoteOrigin, TurnMeta } from "../core/types.js";
import { formatTurnMeta, isSilentReply, quietLabel } from "../core/reply.js";
import { sendAttachments, splitAttachments } from "./attach.js";
import { noteBody } from "./lines.js";
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

const footerText = (meta: TurnMeta): string => escapeMrkdwn(formatTurnMeta(meta));

export class SlackOutbound {
  /** Latched off on the first refusal, so the failed round trip is paid once. */
  private markdownBlocks = true;

  constructor(
    private readonly api: Pick<SlackClient, "postMessage" | "updateMessage" | "uploadFile">,
    private readonly log: (message: string) => void,
  ) {}

  /** No `threadTs` is the home DM's main flow (slack.ts target). Answers
   *  whether anything was posted. */
  async reply(channel: string, threadTs: string | undefined, reply: AgentReply): Promise<boolean> {
    // A local file link is dead in Slack: the bytes are uploaded instead.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    const footer = reply.meta ? footerText(reply.meta) : "";
    const row = actions(reply.suggestions);
    // An empty turn still posts its footer and says which kind of nothing (§5).
    const quiet = isSilentReply(reply)
      ? `_${quietLabel(reply.silence && escapeMrkdwn(reply.silence))}_`
      : "";
    if (!(text || row || footer || quiet || paths.length)) return false;
    const parts = text ? chunk(text, this.budget()) : [""];
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      // The quiet marker shares the footer's block: one muted line, not two.
      const note = last ? [quiet, footer].filter(Boolean).join(" · ") : "";
      await this.post(channel, threadTs, part, [
        ...(note ? [context(note)] : []),
        ...(last && row ? [row] : []),
      ]);
    }
    const lost = await sendAttachments(
      paths,
      async (file) => void await this.api.uploadFile(channel, threadTs, file),
      this.log,
    );
    if (lost) await this.post(channel, threadTs, lost, []);
    return true;
  }

  /** No footer: the turn this input triggers has not ended. Answers with the
   *  `ts` of the last message posted, where the caller puts the 👀. */
  async note(
    channel: string,
    threadTs: string | undefined,
    note: { text: string; origin: NoteOrigin },
  ): Promise<string | undefined> {
    let ts: string | undefined;
    for (const part of chunk(noteBody(note, "_"), this.budget())) {
      ts = await this.post(channel, threadTs, part, []);
    }
    return ts;
  }

  /** A note's root rewritten in place (a child thread's state); one message,
   *  so the body is cut to the smaller budget rather than split. */
  async edit(channel: string, ts: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const body = chunk(noteBody(note, "_"), MRKDWN_MAX)[0] ?? "";
    const blocks = this.markdownBlocks ? [markdown(body)] : sections(toMrkdwn(body));
    await this.api.updateMessage({ channel, ts, text: body, blocks });
  }

  private budget(): number {
    return this.markdownBlocks ? MARKDOWN_MAX : MRKDWN_MAX;
  }

  /** The `markdown` block is recent enough to be refused by an older
   *  workspace; a rejection degrades to the translated mrkdwn path. */
  private async post(
    channel: string,
    threadTs: string | undefined,
    body: string,
    trailing: SlackBlock[],
  ): Promise<string | undefined> {
    // `text` is the notification fallback, never shown beside the blocks.
    const notice = body || trailing.length ? body || "…" : "";
    if (this.markdownBlocks) {
      const blocks = [...(body ? [markdown(body)] : []), ...trailing];
      if (!blocks.length) return undefined;
      try {
        const sent = await this.api.postMessage({ channel, thread_ts: threadTs, text: notice, blocks });
        return sent.ts;
      } catch (err) {
        if (!isBlockRejection(err)) throw err;
        this.markdownBlocks = false;
        this.log(`markdown block refused, falling back to mrkdwn: ${String(err)}`);
      }
    }
    // The body was chunked against the larger budget, so it may split again.
    let ts: string | undefined;
    for (const part of body ? chunk(toMrkdwn(body), MRKDWN_MAX) : [""]) {
      const blocks = [...sections(part), ...trailing];
      if (!blocks.length) continue;
      const sent = await this.api.postMessage({
        channel,
        thread_ts: threadTs,
        text: part || notice || "…",
        blocks,
      });
      ts = sent.ts;
    }
    return ts;
  }
}
