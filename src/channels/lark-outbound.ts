// How a turn becomes cards in a Lark thread: one card per chunk, footer and
// buttons on the last, and what an empty turn still has to say.

import type { AgentReply, NoteOrigin } from "../core/types.js";
import { formatTurnMeta, isSilentReply, originLabel, quietLabel } from "../core/reply.js";
import { sendAttachments, splitAttachments } from "./attach.js";
import type { LarkCard, LarkClient, LarkElement } from "./lark-api.js";
import type { HandoffNote } from "./types.js";
import {
  button,
  buttonRow,
  card,
  chunk,
  footer,
  LARK_MAX,
  markdown,
  OFFER_PREFIX,
  withFooter,
  withoutButtons,
} from "./lark-render.js";

const SENT_CACHE = 200;

export class LarkOutbound {
  /** A 2.0 card cannot be read back (LarkActionValue), so what we sent is the
   *  only copy to retire buttons from. Cosmetic: a click after a restart still
   *  works, the buttons merely stay up. */
  private readonly sent = new Map<string, LarkCard>();

  constructor(
    private readonly api: Pick<LarkClient, "replyCard" | "createCard" | "patchCard" | "uploadFile">,
    private readonly log: (message: string) => void,
  ) {}

  /** An empty turn still posts its footer and says which kind of nothing (§5).
   *  The footer folds into the last chunk's element (a second element renders
   *  a blank gap); only a bodiless turn gets the standalone one. */
  async reply(root: string, reply: AgentReply): Promise<void> {
    // A local file link is dead in Lark: the bytes are uploaded instead.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    const meta = reply.meta ? formatTurnMeta(reply.meta) : "";
    const quiet = isSilentReply(reply) ? quietLabel(reply.silence) : "";
    const note = [quiet, meta].filter(Boolean).join(" · ");
    if (!(text || reply.suggestions.length || note || paths.length)) return;
    const row = reply.suggestions.length
      ? buttonRow(reply.suggestions.map((label, index) =>
        button(label, { key: `${OFFER_PREFIX}${index}`, root, label })))
      : undefined;
    const parts = text ? chunk(text, LARK_MAX) : [""];
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      const elements: LarkElement[] = [];
      if (part) elements.push(last && note ? withFooter(part, note) : markdown(part));
      else if (last && note) elements.push(footer(note));
      if (last && row) elements.push(row);
      if (!elements.length) continue;
      const { messageId } = await this.api.replyCard(root, card(elements));
      if (last && row && messageId) this.remember(messageId, card(elements));
    }
    const lost = await sendAttachments(paths, (file) => this.api.uploadFile(root, file), this.log);
    if (lost) await this.api.replyCard(root, card([markdown(lost)]));
  }

  /** The root, then one card inside its topic: on the phone a topic has its
   *  own composer only once it has a reply. Answers the root's id. */
  async open(chatId: string, note: HandoffNote): Promise<string> {
    const link = note.url ? `[Open on the web](${note.url})` : "(no public URL set — Settings → Instance)";
    const { messageId: root } = await this.api.createCard(chatId, card([
      markdown(`**Continued from web: ${note.title}**\n${link}\nReply in this thread to continue.`),
    ]));
    await this.api.replyCard(root, card([markdown("Reply here to continue.")]));
    return root;
  }

  /** Best-effort: a card sent before a restart keeps its row, logged. */
  async retire(messageId: string): Promise<void> {
    const known = this.sent.get(messageId);
    if (!known) {
      this.log(`options on ${messageId} not retired: sent before this process`);
      return;
    }
    this.sent.delete(messageId);
    const kept = withoutButtons(known);
    await this.api.patchCard(
      messageId,
      kept.body.elements.length ? kept : card([footer("Option taken.")]),
    ).catch((err) => this.log(`retiring options failed: ${String(err)}`));
  }

  private remember(messageId: string, sent: LarkCard): void {
    this.sent.set(messageId, sent);
    while (this.sent.size > SENT_CACHE) {
      const oldest = this.sent.keys().next().value;
      if (oldest === undefined) break;
      this.sent.delete(oldest);
    }
  }

  /** No footer: the turn this input triggers has not ended. Answers with the
   *  id of the last card posted, where the caller puts the 👀. */
  async note(root: string, note: { text: string; origin: NoteOrigin }): Promise<string | undefined> {
    const body = note.text.split("\n").map((line) => `> ${line}`).join("\n");
    let messageId: string | undefined;
    for (const part of chunk(`*${originLabel(note.origin)}*\n${body}`, LARK_MAX)) {
      messageId = (await this.api.replyCard(root, card([markdown(part)]))).messageId;
    }
    return messageId;
  }
}
