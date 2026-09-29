# Compact turn card — the reply bubble is the card, its process a chip row

Status: final. Build as one commit.

## Problem

16 framed each turn: a ring around cause lines, steps lines, the body and the
runs it launched. Every line is its own full-width row at the divider's
weight, so a turn with a callback, a steps line and a run stands three rows
tall around one sentence of reply, and the reply — the thing the reader came
for — is the smallest part of the frame (screenshot: three cards, ~1100px,
two sentences of reply).

## Decisions

- **The reply bubble is the card.** The ring, the card padding and the
  frame fade-in go. What 16 framed lands inside the white bubble: the process
  as one row of chips at the top, the reply text under it, next-step buttons
  at the bottom as now. An error body and a silent body carry the same chip
  row on their own material.
- **Top row, not bottom.** Cause and steps are what happened *before* the
  words: live, the chip row is drawn first and the text streams in under it,
  so nothing moves when the turn ends. The streamed text is therefore the
  bubble's, not the log's: a tool or reasoning boundary moves what streamed
  so far into the steps log as a progress row (it was an update, not the
  reply), and the bubble streams on. The bottom row keeps one verb — the
  next-step buttons send — so a chip that opens a log never sits beside a
  button that sends a message. (Alternative the user named: everything in the
  bottom row beside the buttons; not taken for those two reasons.)
- **One chip per thing that happened, in arrival order** — the same rule as
  16's lines, no summary, no cap:
  - topic tag (as today, first);
  - a cause: kind chip in its state colour and the run's name —
    `callback · succeeded · 过程信息归并实现`, `restarted · continuing`,
    `seed`; a failed callback red, an interrupted one amber;
  - a steps group: `3 steps · 12s`; live `⟳ 3 steps · 8s · writing…`;
    `failed · 2 steps · 6s` red, `interrupted · 2 steps` amber;
  - a launched run: `run · running · 过程信息归并实现`, live across its
    states; a chip arriving after the text appends to the row's end.
  Mode, model, duration, ids and `N queued` leave the chip for its opened
  head.
- **A chip is its fold.** No chevron column: the chip is the button
  (`aria-expanded`), open state its filled ring. Opening lays the detail
  directly under the chip row, above the text, in the material that line
  opens to today — the cause's neutral card with its Session link, the steps
  log with its per-row tool folds, the run's full head and prompt. Several
  chips may be open; details stack in chip order. Every chip starts closed
  and opens only by its own click: the bar's Show work control and its
  `localStorage` choice go (user: a global open is never what is wanted); a
  replayed log's detail is still fetched on its first open (`data-lazy`).
- **A next-step click is a reply.** The label is sent through `withQuote`
  against the reply that offered it, exactly as pressing Reply then typing
  it: the user bubble shows the quote block, the model reads
  `[re assistant …]` over the excerpt and knows which offer was taken. The
  composer's staged quote is untouched — a click is still a side action.
- **A turn with no text** (interrupted before it spoke) is a bubble holding
  only its chip row. A cause a user bubble cut off from its reply stays a
  chip-row-only bubble where it was, as 16 left the line unframed.
- Adoption, replay parity, the topic bar (now the bubble's inset edge as on
  any tagged reply), chat command answers and IM surfaces: as in 16.

## Behaviour (the contract for 03 and 06)

- Bubble: the assistant material as today; the chip row is
  `flex-wrap gap-1.5` at 11.5px under the bubble's top padding, the text
  under it with the topic tag's current gap. No ring, no card padding, no
  `frame-in`.
- Chip: the `.run-label` material (state colour at 8% fill), name in the
  bubble's type, a spinner where a line spins today. Focus ring visible;
  Enter/Space toggle. On touch the hit area extends to 44px tall without
  growing the chip (an invisible padding, as the row tools do).
- Detail: full bubble width, the fold material of today, `margin-block`
  matching the chip row's gap; closes with its chip.
- Live: a cause opens the bubble at the tail with its chip; the steps chip
  joins it and spins; deltas stream under the row; at turn end the steps
  chip settles and the buttons append. Reconnect and reload build the same
  bubble from the snapshot's system inputs, `steps` and `backgroundRuns`.
- Phone: chips wrap; the bubble keeps `max-width: 88%`; an opened steps log
  is the bubble's width.
- Reduced motion: no change beyond the deleted fade.

## Changes

1. `web/ui/chat.ts`: a chip opens the turn's bubble at the tail
   (`data-pending` until its body lands) or joins it; `appendTurn` fills the
   pending bubble with a reply, or with an error once nothing is in flight
   (`completeTurn` takes `turn-end`'s `error` so the row that follows is the
   result; replay passes the turn's `error` to `replayActivity` for the same
   red chip); an error mid-flight is a bare row above the pending bubble;
   deltas stream into it; a run chip joins the tail bubble even after its
   text; `droppedAfter` counts messages, not chip-only bubbles;
   `renderAssistant` sends the picked label with `withQuote` of its own row.
2. `web/ui/turn-activity.ts`: cause, steps and run lines render as chip +
   detail pair (`chip`, `chipInto`) rather than `FOLD_ROW` rows; the run
   head keeps its full form inside the detail; `setWorkOpen`/`workOpen` and
   the expander go; `session-header.ts` and `index.html` lose `#work-toggle`.
3. `web/ui/composer.ts`: `send(mode, label, quote?)`, the label path
   wrapping with `withQuote` when given a source.
4. `web/ui/topics.ts`: `tagRow` places the tag as the row's first chip.
5. `web/ui/style.css`: delete the `[data-kind="turn"]` ring, padding, fade
   and the per-line margins inside it; the chip row, open state, detail
   spacing, touch hit area.
6. `docs/design/03-web-workbench.md` §Chat pane (Turn card, Reply, next-step
   paragraph) and `06-ui-ux.md` §Conversation and activity.
7. Tests: `chat.test.ts` chip order (cause, steered input between two steps
   groups, late run), detail open/close and Show work, quoted next-step send,
   replay parity; `composer.test.ts` label + quote.
