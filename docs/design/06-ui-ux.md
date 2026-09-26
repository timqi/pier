# Pier UI/UX Design Principles

The workbench's presentation contract for implementation and review. Browser UI
only; IM messages and Boards need not reproduce it. [Web Workbench](03-web-workbench.md)
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

- **Solid**: replies, modal forms, the search palette, file previews, menus and
  popovers.
- **Glass + hairline + shadow**: navigation and floating controls only. One
  token set — canvas one step darker than the panel, neutral translucent
  hairline (light in dark mode), top-edge highlight, two-part shadow (wide
  ambient + tight contact) — shared by the bar, floating controls and menus; the
  composer and the open drawer take it one step raised.
- Corner radii coordinate with nesting. Reuse the shared palette, controls,
  menus and time labels; no page-specific styles.
- Canvas: pale neutral page edge, matched by installed-window theme metadata in
  both themes including startup (`--workbench-canvas`). Mist-blue and mint
  accents confined to the lower conversation area.
- Accent: the `--color-indigo-*` ramp is the one accent mechanism — every
  primary action, selection, focus ring and user bubble is an `indigo-*`
  utility, never a literal colour. An instance's accent (Settings → Instance)
  is that ramp re-authored per preset in `style.css`, light and dark, keyed by
  `<html data-accent>`; the manifest and icon take the preset's 600 step from
  the server's table. No colour math at runtime, no second palette.

## Layout

- **One column**: the conversation fills the width without a permanent rail.
- **Bar**: one glass strip at every width; child sessions show ‹, title and phase. The status chip opens In progress; model, reasoning and context are metadata chips. ⋯ opens the bar menu.
- **In progress**: a popover under the status chip at widths ≥640px and a bottom sheet below 640px; both use the menu primitive.
- **Settings and Files**: overlays that return to their origin with ✕ or Esc. Settings' head contains the version link and theme toggle.
- **Composer and transcript**: the transcript fills the pane beneath the bar; the composer accounts for the safe-area inset.
- **Palette**: solid panel with floating-chrome edge and raised shadow; flat
  rows; keyboard selection a tinted pill, medium weight, no edge bar;
  sentence-case section labels; matches marked by ink and weight. 0.9375rem
  labels in 2.5rem rows (44px on touch); 1.75rem Lucide tile per row; no rules
  between rows or groups; 0.8125rem subtitle truncating before the label;
  0.75rem marks; 1.0625rem input in a 3.25rem band.
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
  with a title band and its own scroller. Below md they stack — nav or tree
  first at half the height — and every row, control and download in them is a
  44px target; a head with no tab row keeps its chips and close on one line,
  and a path too long for a phone wears its last segment instead.
- **Model picker**: fills its panel; long titles truncate in a bounded width.
  Reasoning effort: inline disclosure with styled native radios, visible
  selection and focus, no nested overlay.
- Action labels: 0.9375rem desktop / 1rem phone at 1.5.
- A dialog hosting viewport-fixed menus uses no backdrop blur or transform
  animation (containing-block changes). Menus stay in its top layer; clip only
  what needs clipping. Verify actual overlay hit targets.

## Conversation and activity

- User messages: bounded mist-blue surface, dark text, muted dark variant.
  Roles read from alignment, fill and outline before text.
- Assistant replies: solid reading surface, comfortable width.
- During a turn, progress, thinking and tool activity live in expandable steps
  before the reply; after it, the final text is the reply — not duplicated, no
  empty activity groups.
- Live rendering, restored history and reconnection replay tell one story.
- Aborted work keeps its unfinished text; errors and states without a reply
  stay explicit. Nothing that happened may disappear.
- Activity history limits never displace queued or running work.
- System inputs (seed, callback, delegation): one line at the divider's weight
  — chevron, kind chip, topic, id in mono — opening in place to a wide neutral
  card; failure text stays on the line. Chat command answers stay open.
- Status colors: cyan delegation/callbacks, amber for attention (a callback
  not yet landed), clear success/failure/interruption for results; running is
  neutral — the spinner carries the motion. Accents small.
- Time separators at the first user message, after a ten-minute gap, across
  dates; absolute plus relative. Essential context never depends on hover.
- The continuous conversation's divider between two sessions is a time
  separator naming the rotation; an earlier session reads like the head, less
  its edit and next-step controls.

## Editing and forms

- Only the latest user message is editable, even after a reply; its control
  sits beside the bubble with touch and keyboard access. Say that an edit
  resends the question and replaces subsequent replies. Reject stale or
  busy-session edits; allow cancel; on failure restore the server's history
  with a visible reason.
- Primary actions belong with the page heading or navigation, not in filters
  (`New task` beside the Tasks tabs).
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
- Report actual browser coverage (glass, dialogs, transforms, native controls).
  Chromium emulation is not native Safari / iOS. Record gaps and fix them within
  the affected controls.

[Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials) and
[Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion) inform the
visual direction.
