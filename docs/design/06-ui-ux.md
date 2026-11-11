# Pier UI/UX Design Principles

The workbench's presentation contract for implementation and review. Browser UI
only; IM messages need not reproduce it. [Web Workbench](03-web-workbench.md)
owns behavior and wire contracts; [AGENTS.md](../../AGENTS.md) the engineering
boundaries. Explicit user requirements take precedence; a change to a convention
updates this document.

## Hierarchy

- Rounded shapes, layered materials, natural transitions (iOS/macOS 26) within
  the web platform. Readability, clear state and responsive interaction first.
- Primary content on stable reading surfaces; controls on lighter floating
  layers; activity and metadata never compete with the conversation.
- Hierarchy by spacing, size, placement and contrast — not opacity.
- Light and dark coherent; visible focus; status conveyed beyond color.

## Materials

- **Solid**: replies, modal forms, file previews, menus and popovers.
- **Flat chrome + hairline**: navigation, the sidebar and floating controls are
  one solid surface, `--workbench-chrome`, one step off the canvas, edged by a
  neutral hairline (`--line`, light in dark mode) — no blur, no gradient, no
  shadow. The chrome is `oklch(93.8% 0.005 175)` light and `oklch(22.5% 0.006 248)`
  dark: the native shell's tab bar meets it with no line between and paints in
  the same two literals, in the palette the page reports
  ([14 §Bridge](14-native-client.md#bridge-srcwebuishellts)). Menus and popovers are solid, hairline-edged and carry the one shadow
  (`--shadow-pop`). Radii are 6–10px: 10px for cards, menus and the composer,
  6px for rows and icon buttons. The Console's cards, tabs and dialogs are the
  same material: a hairline card, a flat tab whose open state is the row
  selection tint, a hairline dialog with the one shadow.
- Corner radii coordinate with nesting. Reuse the shared palette, controls,
  menus and time labels; no page-specific styles.
- Canvas: pale neutral page edge, matched by installed-window theme metadata in
  both themes including startup (`--workbench-canvas`). Mist-blue and mint
  accents confined to the lower conversation area, half a step off the canvas.
- Accent: the `--color-indigo-*` ramp is the one accent mechanism — every
  primary action, selection, focus ring and user bubble is an `indigo-*`
  utility, never a literal colour. An instance's accent (Settings → Instance)
  is that ramp re-authored per preset in `style.css`, light and dark, keyed by
  `<html data-accent>`; the manifest and icon take the preset's 600 step from
  the server's table. No colour math at runtime, no second palette; the one
  exception is a topic's colour (`topics.ts` `topicHue`), a hue hashed from
  the open item's key so it holds across sessions and reloads without a table;
  it paints the topic tag and the status panel's dot, never a bubble's edge.
  The tag's text is that colour mixed 40% toward `--color-neutral-900`, the
  ink that flips with the theme, so it reads on either theme and either bubble.

## Layout

- **Two columns, one reading column**: from 64rem the shell is a 16rem sidebar beside a content column; the sidebar runs the window's full height on the chrome surface with a right hairline, headed by the instance's name (`$PIER_TITLE`, the host when unset) in a row the bar's height with no line under it, then Chains over Items · N on one gutter — a row's dot 0.5rem in from its plate, its text 1.5rem, the chain rows' line the item rows' too; 64rem is the 46rem reading column, its two 1rem insets and the sidebar, carried by hand in `chains.ts` and `style.css` since a media query reads no custom property; the content column is the bar, the transcript and the dock. Hidden by ⌘B or below 64rem the content column is the window. In it the conversation is a 46rem reading column (`--read-w`, inset by `--col-pad`: transcript, queue card, composer share both edges) centred under the bar; a reply is the full column, a user bubble 76% of it at most; a phone's inset is 0.75rem. The sidebar carries the open items from 64rem; below it the status panel does.
- **Type scale**: the root is 18px below 48rem and 16px from it; the transcript's body is 16px / 1.55 at every width.
- **Stream rhythm**: two steps, `--turn-gap` (0.75rem) between turns, separator lines (date, `· N background updates`, session divider, load more) and from the bar and composer; `--tight-gap` (0.375rem) within a bubble (chip row, topic tag, quote, files) and between a reply and its continuation.
- **Bar**: one flat strip with a bottom hairline, the content column's width; the conversation's title is its chain's name — a plain heading while the sidebar is docked beside it, `<chain> ▾` opening the floated chain list otherwise; child sessions show ‹, title and phase. Right of the title a `1/N` counter cycling the lead comes first, so it stays put whatever the lead's length; then the status panel's most urgent row leads — topic dot, title, status mark and phrase, truncated — and opens the panel; below md the status glyph and the row count; model, reasoning and context are metadata chips. ⋯ opens the bar menu. On a phone it is the same strip — no hamburger, no drawer toggle — keeping the notch inset, and a child session's ‹ is a 44px target at its left, the item view's `×` one beside its title; nothing is phone-only but the menu primitive's sheets.
- **Floating buttons**: icon-only hairline circles, ⌂ over ↓, right edge on the reading column's, 10px above the dock's top card so they follow its height and clear the send key at every width; 44px on coarse pointers; a hidden one leaves the stack, so the other rests on the dock, and each fades in and out with a short rise.
- **Status rows**: the panel and `/status` share a topic dot, a two-line title, a second line of a status mark (amber waiting, sky in progress, red failed, neutral queued, green wrapping up) and the stage's short phrase, then `· open <age>` when the item has an opening time, and useful time/goal/worker metadata; no row reserves a badge column. A row is one control, a 44px target on coarse pointers, its full problem a tooltip when the title is shorter; refresh preserves focus by item identity. In the panel and the sidebar an item's row adds two icon buttons at the row's right, its item view and Close — floated over the row on hover or focus with a fine pointer, always and 44px on a coarse one. The sidebar's row drops the metadata line (its tooltip keeps the full text) but keeps the second line's age; the panel's shows both.
- **Status panel**: one flat waiting-first list under a search field uses the existing popover at ≥640px and sheet below it, dropped from the bar's lead item; on a coarse pointer the first row, not the field, takes focus on open. A row of another chain carries its name as a small neutral chip beside the title (` · archived` included), never a colour of its own.
- **Chain list**: one set of rows on two surfaces — the popover (≥640px) or sheet dropped from the bar's title, and the sidebar's Chains section from 64rem (**Two columns** above), hidden by ⌘B and remembered. A row is a dot, a two-line name and `N waiting`, the current one an indigo-50 surface with indigo-700 text; hover and focus a neutral step; one vocabulary with the status panel's rows; its ⋯ shows on hover or focus with a fine pointer and always on a coarse one, where rows and ⋯ are 44px targets, and opens the menu primitive's popover with Rename…, Charter… and Archive. Create and rename are inline fields, a refusal a red line under them on the surface that asked; the sidebar's New chain is the `+` in its Chains head, the floated list's a last row; archived chains fold under `Archived · N`. `/status` keeps its solid reading card and counted groups.
- **Settings, Files, System prompt and Charter**: Settings is an overlay that replaces the content column — the sidebar stays, and a row of it leaves Settings for the chain or item — and returns to its origin with ✕ or Esc; its head contains the version link and theme toggle. Files, System prompt and Charter are modal dialogs over whatever is open, full-screen below md; ✕ or Esc leaves that as it was — Charter asks first when it holds unsaved text. System prompt's head lists its blocks as plain text buttons, a 44px target on a phone, where the row scrolls sideways instead of wrapping. Charter is one textarea in the controls' material, monospace, its count and Cancel and Save in a footer; below md its buttons are 44px and its text 16px or larger, so iOS does not zoom.
- **Composer and transcript**: the transcript fills the pane beneath the bar; the composer accounts for the safe-area inset. `+` and send/stop stay on the draft's row at every length, bottom-aligned beside it, while the text grows upward between them; its height is read again when the width changes.
- **Mic**: `#attach`'s size, circle and neutral icon, left of stop/send. Idle a `Mic`; starting a `Mic` and recording a `Square`, both on the `indigo-50` tint with `aria-pressed="true"`; finishing a `Square`, grey and disabled. While a take runs an `X` cancel in the same material sits left of it, its hint naming Esc. `title` names the state. No level meter and no animation: the state is the icon, the tint and the text arriving in the draft.
- **Menus**: labels align without a reserved selection column; only selectable
  options reserve checkmarks; restrained separators; secondary hints truncate;
  focus leaving a nonmodal menu dismisses it. Phone sheets name the target
  session, provide a close control, and have a backdrop that dismisses without
  activating controls beneath.
- **Session info**: solid reading surface; grouped label/value fields; explicit
  navigation; monospace for identifiers only; copy controls reachable on touch.
  0.9375rem body at 1.5, 1.125rem titles, 0.8125rem supporting text; 26rem
  desktop width; relative times beside timestamps when space allows; paths and
  IDs 0.875rem monospace, wrapping.
- **Two-pane Console views** (Agent, Files): panes are the panel surface
  clipped to its own radius, inset on the canvas under the page head, each
  with a title band and its own scroller. Below md Files stacks, tree first
  at half the height, and Agent is a list page and a detail page whose title
  band leads with ‹ — and every row, control and download in them is a
  44px target; a head with no tab row keeps its chips and close on one line,
  and a path too long for a phone wears its last segment instead.
- **Model picker**: fills its panel; opened from ⋯, its head keeps only back and
  close controls.
  Reasoning effort: inline disclosure with styled native radios, visible
  selection and focus, no nested overlay.
- Action labels: 0.9375rem desktop / 1rem phone at 1.5.
- A dialog hosting viewport-fixed menus uses no backdrop blur or transform
  animation (containing-block changes). Menus stay in its top layer; clip only
  what needs clipping. Verify actual overlay hit targets.

## Conversation and activity

- User messages: bounded surface at half the accent's tint (`indigo-100` mixed
  even with the card white) under an `indigo-200` edge, dark text, muted dark variant.
  Roles read from alignment, fill and outline before text.
- Transcript type: 16px at line-height 1.55 whatever the root, a step under the draft's 1rem; markdown sizes are em that land on whole pixels (headings 1.25em/1.125em, inline code 0.875em).
- Assistant replies: solid reading surface, comfortable width; on a phone the
  full column. A fenced code block keeps its lines and scrolls sideways in its own box; a table scrolls sideways in its own box, columns as wide as
  their text up to a bounded cell, an edge shade on the side with more; a
  short one stays content-sized. A lone image is a 4:3 contained preview up to
  17.5rem, its space held before it loads; several stay 64px tiles.
- During a turn, progress, thinking and tool activity live in expandable steps
  before the reply; after it, the final text is the reply — not duplicated, no
  empty activity groups. The chip row draws first and the text streams under
  it, so nothing moves when the turn ends.
- Live rendering, restored history and reconnection replay tell one story.
- Aborted work keeps its unfinished text; errors and states without a reply
  stay explicit. Nothing that happened may disappear.
- Activity history limits never displace queued or running work.
- A turn is its reply bubble. Its process is one row of chips at the top —
  the topic tag, then a chip per cause (callback, delegation), steps
  group and launched run, in arrival order — the text under it, next-step
  buttons at the bottom (an earlier turn's muted, on an open topic's newest
  reply only). A chip is the `.run-label` material in its state colour (a failed
  callback red, an interrupted one amber, running sky with a still dot) —
  outlined, `currentColor` at 28%, filled 10% on hover or while open, so the
  topic tag's fill is the row's one badge of belonging —
  and the run's name in the bubble's type; the count of chips
  is the count of things that happened, and no chip summarises the others.
  An error or silent body carries the same row on its own material.
- A turn Pier's own stop cut, continued by the restart input after it, is no
  failure: its steps chip reads grey `restarted` with a `RefreshCcw` glyph, the
  grey of cancelled and skipped, and it carries no error row.
- Consecutive silent replies fold under one grey line, `· N background
  updates`, no material of its own: closed by default and after the topic's
  final reply, opened and closed only by its click (`aria-expanded`, a 44px
  touch hit area) or by a jump to a folded reply. A silent reply with a
  failed, interrupted or in-flight chip is not folded.
- A chip is its fold: the button (`aria-expanded`, Enter/Space, a visible
  focus ring; on touch a 44px hit area that does not grow the chip) whose
  open state is a ring, laying its detail — the cause's neutral card, the
  steps log, the run's head and prompt — under the row, at the bubble's
  width, in chip order. Every chip starts closed and opens only by its own
  click, closing any other open chip in its row — one detail per bubble,
  other bubbles untouched; there is no global open. The one exception is a
  run's session, opened to watch it work: while its one bubble's turn runs,
  the steps chip starts open and its log fills the pane between bar and
  dock; a reader's close holds, reloads included, and the end of the turn
  leaves the chip as it stands. Mode, model, duration
  and ids are the opened head's, never the chip's; a cause card's head does not
  repeat the chip's kind and state. Chat command answers stay open cards.
- A quote is a neutral grey bar and two clamped lines at the top of the
  user's bubble, the excerpt in the bubble's own type at a
  step down, a quoted reply's markdown shown as its words; the row controls (Reply, Edit) share one gutter and one hover.
  Without hover they are not painted (focus-visible and screen readers still
  reach them): a finger swipes the row right to reply — the row follows, a
  Reply glyph fills in and turns indigo at the release point — and holds it
  for a sheet of Reply, Copy, Edit, Select text.
- Status colors: cyan delegation/callbacks, amber for attention (a callback
  not yet landed), clear success/failure/interruption for results; running is
  a sky label and a still `.running-dot`, the current turn's steps chip
  included. Accents small.
- Time separators at the first user message, after a ten-minute gap, across
  dates; absolute plus relative. Essential context never depends on hover.
- The head's divider between two sessions is a time
  separator naming the rotation; an earlier session reads like the head, less
  its edit and next-step controls. The divider is the session seed's fold,
  opening the seed's card under it; a session with no divider above draws
  its own, in the same words.

## Editing and forms

- Any user message is editable, even after a reply; its control
  sits beside the bubble with touch and keyboard access. Say that an edit
  resends the question and replaces subsequent replies. Reject stale or
  busy-session edits; allow cancel; on failure restore the server's history
  with a visible reason.
- Primary actions belong with the page heading or navigation, not in filters.
- Visible labels, one grid. Secondary filters disclose progressively; active
  conditions are always discoverable (an active date range expands and counts
  toward reset). URL state, reset, Back and restored fields agree. Background
  refreshes preserve input, focus, scroll and in-progress interactions. Long
  labels or date controls never set the page's width.

## Motion

- Brief, restrained, interruptible; explains feedback and spatial relations.
  No global suppression. Reuse existing easing and browser primitives.
- Logical state changes immediately even while a visual exit continues:
  closing controls stop accepting input; cleanup never removes a replacement or
  leaves an invisible blocking layer; rapid reversals continue from the visible
  state.
- Animate deliberate changes, not streaming updates, refreshes or restored
  messages. Preserve the reader's position unless following the bottom.
- Nothing animates for as long as work runs or loads: no spinner, pulse or
  infinite animation anywhere; running is a static `.running-dot` (fill plus
  outline) beside its status text, loading a still skeleton.
- Reduced motion: short fades, less movement. Reduced transparency / increased
  contrast: solid surfaces. Unsupported features fall back to instant changes
  keeping content, semantics and keyboard access.

## Foundations

- One source of truth: existing snapshots, events, activity types, status
  mappings; no parallel presentation records. Extend shared primitives, remove
  obsolete styles; no speculative abstractions, no new frameworks.
- Native controls and semantics, readable contrast, visible focus, 44px touch
  targets.
- Icons: Lucide, 24-unit viewBox, 2-unit rounded strokes, `currentColor`, via
  named imports through `ui/icons.ts` — never hand-drawn SVG or Unicode.
  Default 0.875rem; compact disclosures and status marks 0.75rem; icon size
  never shrinks the hit target. Decorative SVGs hidden from assistive
  technology; the control keeps its text or label and state text. Brand, data
  graphics, shortcut notation and symbols in content stay intact.
- Safe areas and software keyboards accounted for; content panels own
  scrolling; wide content never scrolls the conversation horizontally.

## Validation

- Exercise normal use, failure, cancellation, interruption, loading,
  reconnection; keyboard, pointer, touch; narrow and wide; light and dark;
  accessibility preferences. Check rapid interaction and real hit targets —
  screenshots alone do not establish correctness.
- Code checks for implementation changes; content and link checks for docs.
  Isolated mock data only; never real tasks or production services.
- Report actual browser coverage (hairlines, dialogs, transforms, native controls).
  Chromium emulation is not native Safari / iOS. Record gaps and fix them within
  the affected controls.

[Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials) and
[Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion) inform the
visual direction.
