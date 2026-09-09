// How a turn becomes messages in a Slack thread: which renderer, how to chunk
// against its limit, and what an empty turn still has to say.

import type { AgentReply, NoteOrigin, TurnMeta } from "../core/types.js";
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

const footerText = (meta: TurnMeta): string => escapeMrkdwn(formatTurnMeta(meta));

export class SlackOutbound {
  /** Latched off on the first refusal, so the failed round trip is paid once. */
  private markdownBlocks = true;

  constructor(
    private readonly api: Pick<SlackClient, "postMessage" | "uploadFile">,
    private readonly log: (message: string) => void,
  ) {}

  async reply(channel: string, threadTs: string, reply: AgentReply): Promise<void> {
    // A local file link is dead in Slack: the bytes are uploaded instead.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    const footer = reply.meta ? footerText(reply.meta) : "";
    const row = actions(reply.suggestions);
    // An empty turn still posts its footer and says which kind of nothing (§5).
    const quiet = isSilentReply(reply)
      ? `_${quietLabel(reply.silence && escapeMrkdwn(reply.silence))}_`
      : "";
    if (!(text || row || footer || quiet || paths.length)) return;
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
      (file) => this.api.uploadFile(channel, threadTs, file),
      this.log,
    );
    if (lost) await this.post(channel, threadTs, lost, []);
  }

  /** No footer: the turn this input triggers has not ended. Answers with the
   *  `ts` of the last message posted, where the caller puts the 👀. */
  async note(
    channel: string,
    threadTs: string,
    note: { text: string; origin: NoteOrigin },
  ): Promise<string | undefined> {
    const body = note.text.split("\n").map((line) => `> ${line}`).join("\n");
    let ts: string | undefined;
    for (const part of chunk(`_${originLabel(note.origin)}_\n${body}`, this.budget())) {
      ts = await this.post(channel, threadTs, part, []);
    }
    return ts;
  }

  private budget(): number {
    return this.markdownBlocks ? MARKDOWN_MAX : MRKDWN_MAX;
  }

  /** The `markdown` block is recent enough to be refused by an older
   *  workspace; a rejection degrades to the translated mrkdwn path. */
  private async post(
    channel: string,
    threadTs: string,
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
