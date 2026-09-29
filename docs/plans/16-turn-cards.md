# Turn cards — a reply carries what caused it and what it did

Status: final. Build as two commits: the card first, reply second.

## Problem

A reply's process is scattered around it: cause lines (callback, delegation,
seed) above, the steps line above, and since 15 a process line under it that
folds runs and callbacks twice — a summary line, then cards, then each card's
chevron. Nothing says which of it belongs to which reply, and the summary
hides the run's name and model, which the one-line cards used to show.

## Decisions

- **One card per agent turn.** Everything from the turn's inputs to its
  result is one framed row: cause lines, steps line, body, launched-run
  lines. The frame says "these are one thing"; nothing else is regrouped —
  the stream stays one chronological column.
- **No summary line anywhere.** Every cause, every step group, every run is
  its own line, the one-line form 06 already specifies (chevron, kind chip,
  state, name, model badge, ids), opening once to its text. The process line
  and its `N runs · M callbacks` count are deleted. The count of lines is the
  count of things that happened.
- **A user message is never a cause line.** The bubble above the card is the
  cause; a reply straight after a user message carries no cause line. Cause
  lines are system inputs only: callback, delegation, task message, session
  seed, restart.
- **Before the body lands, the lines stand alone** at the pane's tail exactly
  as today — cause line(s) already drawn, the steps line live with its
  spinner and `writing…`. At turn end the body appends under them and the
  frame closes around lines and body. Nothing moves; the frame fades in.
- **Every turn ends as a card**, body or not: a reply (markdown), `stayed
  silent — <reason>` (quiet text), a failed turn's error (red), or no body
  when the turn was interrupted before it spoke — the steps line then reads
  `interrupted · N steps` and is the card's whole content.
- **Multiple inputs to one reply** are multiple cause lines, in arrival
  order; a steered input keeps its place between the two steps lines it
  split. No cap, no folding of the list: a reply to five callbacks shows five
  lines.
- **Launched runs are the card's footer**: each run the current one-line
  card, live across its states, opening to its prompt; on replay under the
  turn that launched it, as now. A run therefore appears twice, both facts:
  launched in the card that started it, cause line in the card its callback
  started.
- **Fold state**: per line, in memory, as today. One bar control, **Show
  work / Hide work** (a Lucide chevrons icon, 44px target, the same icon on
  the bar at every width — the phone bar is the desktop bar),
  opens or closes every line-level fold in the pane — cause text, steps log,
  run prompt; tool rows inside a log stay per row, since opening every
  output would fetch every output. The choice is remembered per browser
  (`localStorage`); a card that arrives follows it; a click on one line
  overrides that line.
- **Topics**: the card is one row, so its lines inherit its topic by
  containment; the user bubble above inherits as now; the colour bar runs the
  card's height. The work-group and process-line inheritance in `topics.ts`
  goes.
- **Chat command answers** (`/status`, `/new`, …) are Pier's, not a turn's:
  still a standalone open card. Local UI errors (an edit refused) are still
  standalone rows.
- IM surfaces are untouched; this is `web/ui` only.

## Behaviour (the contract for 03 and 06)

- Card: `fold-row` material inside a hairline ring at the reply's radius; the
  reply body keeps its solid reading surface. Cause and run lines keep their
  state-coloured left edge; the card's edge is the topic bar or nothing.
- Steps line: `N steps · 12s`; `failed` and `interrupted` keep their word and
  colour; `working · N steps · 8s · writing…` with the spinner while live. A
  turn with no steps has no line.
- Adoption rule, live and on replay: a body adopts the contiguous cause lines
  and steps groups directly above it, back to the previous body or user
  bubble. A cause line separated from its reply by a user bubble stays where
  it is, unframed.
- Reload, reconnect and live tell one story: the snapshot's system inputs,
  `steps` and `backgroundRuns` build the same cards.
- Phone: the lines already wrap below md (`run-head`); the frame is full
  width; the bar control is the same icon.
- Reduced motion: the frame appears without a fade.

## Changes

1. `web/ui/turn-activity.ts`: delete the process line (`intoProcess`,
   `takeProcessFold`, `refreshProcessSummary`); background-run cards render as
   lines into the current card's footer.
2. `web/ui/chat.ts`: `appendTurn` for assistant/error and the silent line wrap
   the adopted lines and the body in one card element; `appendSystemInput`
   draws lines at the tail as now, unframed.
3. `web/ui/topics.ts`: drop the inheritance into work groups and process
   lines.
4. `web/ui/session-header.ts` + `style.css`: the Show/Hide work control and
   its stored state.
5. `docs/design/03-web-workbench.md` §Chat pane and `06-ui-ux.md`
   §Conversation and activity: replace the process-line and activity-group
   paragraphs with the card.
6. Tests: `chat.test.ts` adoption (single cause, steered input, cause cut off
   by a user bubble, silent, interrupted), replay parity, the global toggle.

# Reply to a message — the user names which message they answer

## Problem

Several topics share one stream. A message typed while a new topic has just
arrived answers one of them, and the agent must guess which; the reader
later cannot tell either.

## Decisions

- **IM reply, not a thread.** A row gets a **Reply** control; the composer
  shows what is being answered; the sent bubble carries the quote; clicking
  the quote jumps to the source. The stream stays one column.
- **The quote travels in the message text**, so it survives reload, edit and
  rotation with no new table, route field or seam — the same rule as the
  speaker header and attachment lines. After the router's speaker header the
  message reads:

  ```
  [re assistant 2026-09-29 11:32]
  > first 240 characters of what that message said
  > (as written, markers included)

  the user's reply
  ```

  `core/identity.ts` gains `withQuote` / `splitQuote` beside the speaker
  header (browser-safe, so the bubble is rendered from the same parser). The
  excerpt is the source's raw text — an assistant row's `<topic>` marker
  rides along, so the agent sees which item the reply is about without
  Pier resolving anything, and the bubble's quote paints that topic's
  colour from the same marker.
- **Only user messages carry a quote.** Any row in the pane can be the
  source — a reply, a user message, an earlier session paged in, a system
  line's text; the agent never quotes.
- **The agent is told once**: one sentence in Pier's runtime `AGENTS.md`
  (beside the speaker-header paragraph): a message opening with `[re <role>
  <time>]` over a `>` block answers that earlier message, quoted.
- **Jump**: the source is found in the pane by role and time (`data-time`,
  minute precision) then the excerpt's prefix; the pane scrolls to it and
  flashes its ring once. A source not in the pane (trimmed, a session not
  paged in) leaves the quote inert, its tooltip saying so.
- **Toolbar**: the existing edit pencil's slot becomes the row's toolbar —
  Reply for every user and assistant row, Edit for user rows — with the
  pencil's hover/touch rules (`.message-edit`); nothing else in it.
- **Composer**: a quote strip above the input — `↰ assistant · 11:32 ·
  excerpt`, one line, × to drop it; Reply focuses the composer; Esc with an
  empty draft drops the quote; sending clears it. A quote sends in any mode
  (Send, Send now) and while streaming.
- **Bubble**: the quote is a block at the top of the user bubble — a left
  bar in the topic colour when the excerpt names one, else the accent's
  300 step; `role · time` in small mono; the excerpt clamped to two lines,
  markers stripped as replies strip them. Edit resends the raw text, quote
  included.
- IM channels are untouched; the format is platform-neutral so an adapter
  may map its native quote onto it later. Content search sees the excerpt;
  that is acceptable.

## Changes

1. `core/identity.ts`: `withQuote({role, at, text}, body)` and
   `splitQuote(text)`; the `[re …]` line uses the header's time shape.
2. `web/ui/chat.ts`: the row toolbar; assistant rows keep `dataset.raw`;
   `appendTurn` for user rows renders the quote block and its jump.
3. `web/ui/composer.ts`: the quote strip and its state; the send prepends
   `withQuote`.
4. Pier's runtime `AGENTS.md` (the chat-surface text in `agent/`): one
   sentence.
5. `docs/design/03-web-workbench.md` §Chat pane, `06-ui-ux.md` §Editing.
6. Tests: `identity.test.ts` round trip; `chat.test.ts` render, jump, inert
   quote; `composer.test.ts` strip, Esc, send.

