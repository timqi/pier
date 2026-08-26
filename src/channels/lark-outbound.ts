// How a turn becomes cards in a Lark thread.
//
// Split from the adapter the way slack-outbound.ts is: what a turn renders as
// — one card per chunk, footer and buttons on the last, and what an empty turn
// still has to say — is a different decision from routing inbound traffic. The
// adapter keeps the 👀 receipts, because those are about the turn ending, not
// about what was said.

import type { AgentReply, NoteOrigin } from "../core/types.js";
import { formatTurnMeta, isSilentReply, originLabel, quietLabel } from "../core/reply.js";
import { sendAttachments, splitAttachments } from "./attach.js";
import type { LarkCard, LarkClient, LarkElement } from "./lark-api.js";
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

/** How many sent cards the retire cache remembers (avibe keeps 200). */
const SENT_CACHE = 200;

export class LarkOutbound {
  /**
   * The cards this process sent with buttons on them, for retiring the row
   * once an option is taken — a 2.0 card cannot be read back from the
   * platform (see LarkActionValue), so what we sent is the only copy.
   * In-memory and bounded, copied from avibe: purely cosmetic state. A click
   * after a restart still *works* (the label rides in the value); the buttons
   * merely stay up, and the skip is logged.
   */
  private readonly sent = new Map<string, LarkCard>();

  constructor(
    private readonly api: Pick<LarkClient, "replyCard" | "patchCard" | "uploadFile">,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Post one turn as replies into the conversation's thread, empty text
   * included: a turn that produced nothing still posts its footer and says
   * which kind of nothing it was — total silence is indistinguishable from a
   * crash, and the person watching the 👀 come off has no way to tell.
   *
   * The footer folds into the last body chunk's own markdown element (a
   * second element renders a blank gap); only a bodiless turn gets it as the
   * standalone muted element. Buttons ride the last chunk, like every other
   * platform — the card is remembered so retire() can rebuild it without them.
   */
  async reply(root: string, reply: AgentReply): Promise<void> {
    // A file the agent linked lives on Pier's machine, so the link is dead in
    // Lark: the bytes are uploaded instead and the label stays in the text.
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
    // Attachments follow the words, so the card introducing them is above
    // them; anything that could not be sent says so in the thread.
    const lost = await sendAttachments(paths, (file) => this.api.uploadFile(root, file), this.log);
    if (lost) await this.api.replyCard(root, card([markdown(lost)]));
  }

  /**
   * Take the buttons off a card one option was just taken from — the rest
   * answer a question the conversation has moved past. Best-effort by design:
   * an unremembered card (sent before a restart) keeps its row, logged.
   */
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

  /**
   * A system note: quoted, labelled with where it came from, and deliberately
   * plain — no buttons and no turn footer, because the turn this input
   * triggers has not ended yet.
   */
  async note(root: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const body = note.text.split("\n").map((line) => `> ${line}`).join("\n");
    for (const part of chunk(`*${originLabel(note.origin)}*\n${body}`, LARK_MAX)) {
      await this.api.replyCard(root, card([markdown(part)]));
    }
  }
}
