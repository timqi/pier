# Continuous conversation — open items: the chat commands and the IM surface

The contract for the chat commands over the continuous conversation — `/new`,
`/stop`, the composer's completion of them — and for the IM surface, unbuilt.
Markers, table, `openItems()`, the text, `/status`, the rail's In progress rows are
[10 §Open items](10-continuous-session.md#open-items).

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn); an unknown `/word` is a message, never an
error: the composer is not a shell.

| Command | Does | Card |
| --- | --- | --- |
| `/new` | rotates now, reason `new` (the idle seed; `ChainReason` gains it, the divider names it); a head the send already rotated for its own reason is not rotated twice | the new head's seed card is the answer; a streaming head refuses with the send's 409, `the conversation is replying — /stop first`, shown as the composer's error row — a card would sit in the head's queue until the turn it refuses for ends |
| `/stop` | aborts the head's running turn (`AgentSession.abort`), children untouched | `stopped` · `nothing running` |

- The table is `CHAT_COMMANDS` in `core/types.ts` — word → the one line the
  composer's completion shows; `chatCommand` (`core/chain.ts`), the transcript
  rebuild (`agent/events.ts`) and the completion all read it, so none can
  drift. `ChatCommand` is its keys.

## Composer completion

- A draft that is `/` followed by a prefix of a command, the continuous
  conversation on screen, lists the matching commands above the input: the
  word and its line from the table. The exact word hides the list; Enter then
  sends it. Anywhere else the list never opens: `/status` is a message there.
- The textarea keeps the caret. ↑/↓ (and the menus' ⌃N/⌃P) walk, Enter or Tab
  fills the draft with the row's word, a pointer on a row does the same without
  blurring the textarea, Esc closes it until the draft changes.
- The rows are the palette's (`.palette-row`, the `bg-indigo-50` selection);
  `role=listbox`/`option` with `aria-selected`; 44px rows on touch.

## IM

- Comes with Phase 3's DM routing ([10 §IM](10-continuous-session.md#im)), no
  work of its own: Slack takes the words bare (`status`, as it does `stop` and
  `settings`), and an answer or refusal posts as one message in the DM's main
  flow.

## Not in this design

- Nesting workers under their lead in the In progress rail (a separate
  `(proposed)` item; `workers` in the text is what this design gives).
- Deriving a stage from git (merged, pushed): workflow-specific, and the
  line already says it.
- A done list: a removed item's record is the transcript and the daily note.

## Acceptance

- After a day of use, `/status` names every problem in flight or waiting on
  the user's decision, in their words, with a stage that matches the
  transcript; nothing running or failed is missing from it, no backlog in it.
- A stale stage is a failure of the `DISPATCHER` rule, fixed there, never
  patched over in the view.
- Main's cost per item: the marker's tokens in a reply it writes anyway, no
  tool call, no extra model call; no model call answers `/status`.

## Tests

- `core/chain.test.ts`: `/new` rotating and refusing a streaming head, `/stop`
  on a running and an idle head; `web/server.test.ts`: the 409.
- `web/ui/composer.test.ts`: the list at `/`, the prefix, the exact word, the
  keys, Esc, and never outside the conversation.
