# UI shape under the continuous conversation

The browser's frame once the product is one conversation
([11](11-product-shape.md)): what is on screen, where the rest is reached,
and what the frame deletes. [03](03-web-workbench.md) keeps the wire
contract and [06](06-ui-ux.md) the materials; both are updated when this is
final.

## Frame

- **One column.** The conversation fills the width; no permanent rail. The
  rail existed to pick among sessions; under continuous there is one, and what
  else is alive is a count, not a list the user keeps in view.
- **One bar.** A slim glass strip over the transcript (the chat heading and
  the phone bar of [06 §Layout](06-ui-ux.md#layout) become one element at
  every width): title left, chips right, `⋯` last.
- **Two overlays reach everything else**: the *In progress* drawer (what is
  running, what needs me) and the ⌘K palette (everything that ever was, and
  Settings). Nothing has a third route.

```
desktop / phone                         viewing a child session
┌─────────────────────────────────────┐ ┌─────────────────────────────────────┐
│ Conversation   [2 running · 1 needs │ │ ‹ Conversation  Sleep worker  build │
│                 you] [opus-5·low·8k]⋯│ │                 [running] [opus·hi]⋯│
├─────────────────────────────────────┤ ├─────────────────────────────────────┤
│                                     │ │                                     │
│  ↺ session seed · lost · 01a0dd03   │ │  …the child's transcript…           │
│                          Hi         │ │                                     │
│  Hi — ready when you are.           │ │                                     │
│  ⟵ callback · cancelled · Sleep …   │ │                                     │
│  Stayed silent — cancellation …     │ │                                     │
│                                     │ │                                     │
├─────────────────────────────────────┤ ├─────────────────────────────────────┤
│ + Message…                        ↑ │ │ + Message…                        ↑ │
└─────────────────────────────────────┘ └─────────────────────────────────────┘
```

## Bar

| Slot | Conversation | Child session |
| --- | --- | --- |
| left | **Conversation** (opens Session info) | **‹** back to the conversation, wearing the head's dot when it is streaming or unread; then the session's title and its `phase` tag |
| status chip | `N running · M needs you` — opens the drawer; absent when both are 0 | the same chip, the same drawer |
| meta chips | model · reasoning · `used/compactAt` — open the model picker; below md only context ≥ 70% or "starting…" shows, as today | the same |
| `⋯` | Search ⌘K · Session info · Browse files · Model & reasoning · Settings | Session info · Browse files · Model & reasoning · Settings |

- `N running` counts the drawer's green and grey rows; `M needs you` its
  amber ones plus design leads waiting on Finalize. The chip is the drawer's
  attention badge and the tab-title count, one number source
  (`setAttention`).
- The bar is the only chrome. The transcript runs the full pane under it and
  pads by its height; the composer floats at the bottom as today.

## In progress drawer

The In progress list ([03 §Bar and In progress drawer](03-web-workbench.md#bar-and-in-progress-drawer-session-headerts-drawerts))
as an overlay: a panel anchored under the chip at the right ≥ md (the
sidebar's material, 20rem, over the transcript, not beside it), a bottom
sheet below 640px (the menu primitive's sheet, `menu.ts`). Right because the
chip is right and the reading column keeps its left edge.

- Rows unchanged: `<name>` · `phase` tag · dot (green live, amber unread,
  grey queued / design waiting), the run rows for runs with no session yet;
  newest first by birth; same source (`GET /api/sessions` ∩ Running, plus
  `GET /api/continuous/open`'s live runs), re-read on `sessions-changed` and
  `open-items-changed`. Empty → the chip is absent and the drawer cannot open;
  `/status` is the full list.
- A row opens the session in the column (`#/session/<id>`), the drawer
  closes. The **‹** in the bar returns to `#/conversation`. Viewing a row
  marks it read, so an amber row leaves the drawer as today.
- Keys: the chip's click or ⌘⇧P open it; ↑↓ walk, ↵ opens, Esc closes and
  returns focus to the chip. ⌘⇧[ / ⌘⇧] go: the drawer and ⌘K are the two
  walks.
- Focus, inertness and the phone sheet's backdrop follow the menu primitive;
  the drawer uses `menu.ts` (§Deletions).

## Child session

A lead or worker session opened from the drawer, the palette, a callback
card's Session link or a `/status` line.

- Same pane, same composer: the user talks to a design lead in its session
  ([10 §Roles](10-continuous-session.md#roles)), so sends go to
  `POST /api/sessions/:id/messages` as today; a finished worker's session
  takes a follow-up as it does now. Nothing here narrows the seam.
- `⋯`: Session info, Browse files, Model & reasoning. Rename, Close, Continue
  in… stay absent (Phase B's deletion, [11 §Deletions](11-product-shape.md#deletions)).
- The bar's title is the run's `--name`; the tag is the lead's `phase`.
- Reload lands where the hash says; a bare or unknown hash is the
  conversation, as today.

## Transcript density

System rows collapse to one line by default; the transcript reads as the
exchange, with the machinery legible but flat.

| Row | Collapsed line | Expanded |
| --- | --- | --- |
| session seed | `↺ session seed · <reason> · <previous id8>` | the seed text (today's card) |
| callback | `⟵ callback · <state> · <run name> · <model> · <run id8>` | the result text, Session link |
| delegation | `⟶ delegation · <run name> · <run id8>` | the prompt, Session link |
| `/status` | the `Open` card stays open: it is the answer the user asked for | — |
| stayed silent | `Stayed silent — <reason>`, one line, as today | — |
| chat command (`/new`, `/stop`) | its one line, as today | — |

- One `system-row` material for all of them (the divider's weight, not a
  card): chevron, kind chip, the line, id in mono at the end. A click or ↵
  expands to today's card in place; expansion state is per row, in memory.
- Nothing is hidden: a failed callback is a red-chipped line, an interrupted
  one amber, and the count of lines is the count of things that happened
  (principle 5). Failure text is on the line, not behind the chevron.
- Callbacks main *answers* after are the common case; the reply below the
  line is the reading, the line is the receipt.

## Palette (⌘K)

Unchanged in shape ([03 §Search palette](03-web-workbench.md#search-palette-palettets-k)),
trimmed: **Conversation** first, always (opens `#/conversation`, the head's
dot on its row — the one way back from anywhere, a child session or Settings
included); Running = the drawer's rows; Recent = finished leads, IM sessions,
earlier chain members; Actions = Settings (and its topics); content search.
Typed, the Conversation row matches on its word like any session title.
New session and New session in… go with Phase B. On a phone it is the `⋯`
menu's first item; there is no other way in and there need not be.

## Settings

A full-column view, as the Console is today, opened from `⋯` or ⌘K; its own
head (title, topics, close) is the bar's strip. ✕ or Esc returns to where it
was opened from. Files stays the overlay it is (`#/files/<dir>`). The
Console's section, "Console › Settings", has nowhere to live and is the
`⋯` item.

## Phone

The same frame: the bar is the same strip (no hamburger, no drawer toggle),
the status chip opens the sheet, `⋯` opens its sheet with Search first. The
composer keeps the safe-area inset; the bar keeps the notch inset. A child
session's **‹** is the 44px target at the bar's left. Nothing is phone-only
but the sheets, which are the menu primitive's already.

## Wire contract

Nothing new: the routes and streams of [03](03-web-workbench.md). The drawer,
the chip and the bar are consumers of `GET /api/sessions`,
`GET /api/continuous/open`, `sessions-changed` and `open-items-changed`, all
of which exist. A native client draws the same frame from the same four
sources.

## Deletions

| What | Where | Why |
| --- | --- | --- |
| the permanent rail, its toggle, the phone drawer, the scrim, `data-rail`, `pier.railClosed` | `sidebar.ts` (391), `shell.ts` (240), `index.html`, `style.css` | §Frame; the rows move to the drawer module, the rest goes |
| ⌘⇧[ / ⌘⇧] row chords, ⌘⇧O | `sidebar.ts`, `shortcut.ts` | the drawer and ⌘K are the two walks |
| the desktop chat heading and the phone bar as two elements, `hostMeta` moving chips between them | `shell.ts`, `session-header.ts`, `index.html` | one bar at every width |
| the Console section | `sidebar.ts`, `views.ts` | `⋯` → Settings |
| four-line preview on system cards | `chat.ts` | §Transcript density; the card is the expanded state |

Renamed, not new: `sidebar.ts` becomes the drawer module (rows, order, dots,
the chip's counts); a new file needs no justification because it is the old
one with the container swapped.

## Phases

- Requires Phase A of [11](11-product-shape.md) (this branch's base).
- **This design is [11 §Phase B](11-product-shape.md#phases).** One shell:
  the `continuous` switch and every non-continuous branch of the sidebar and
  pane rules, the New session menu, Browse… and the directory picker, the
  working-set rank and Load more, and the UI's calls to `POST /api/sessions`,
  `/close`, `/rename` go in the same change (the routes stay while
  `pier task` and tests use them). The instance is always continuous;
  [10 §Acceptance](10-continuous-session.md#acceptance)'s week runs on this
  frame.

## Decisions

- Phase B folds in: two shells behind a runtime flag is the third copy at
  the shell level.
- Drawer at the right, under the chip.
- Chip absent when nothing runs and nothing needs you; Recent is ⌘K's.
- A callback keeps its receipt line beside main's reply: the line is where
  the run's session is one click away.
