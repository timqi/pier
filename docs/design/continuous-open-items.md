# Continuous conversation — open items, unbuilt

The contract for what is left of the open-items view over the continuous
conversation: chat commands `/new` and `/stop`, and the IM surface. The built
part — markers, table, `openItems()`, the text, `/status`, the rail's Open
block — is [10 §Open items](10-continuous-session.md#open-items); folded into
10 when built.

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn); an unknown `/word` is a message, never an
error: the composer is not a shell.

| Command | Does | Card |
| --- | --- | --- |
| `/new` | rotates now, reason `new` (the idle seed; `ChainReason` gains it, the divider names it) | the new head's seed card is the answer; a streaming head refuses: `the conversation is replying — /stop first` |
| `/stop` | aborts the head's running turn (`AgentSession.abort`), children untouched | `stopped` · `nothing running` |

- `SystemInputOrigin`'s `command` gains `"new" | "stop"`.
- Built after `/status` has been in use: one row of the table each.

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
  on a running and an idle head.
