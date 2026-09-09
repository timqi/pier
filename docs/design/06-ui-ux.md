# Pier UI/UX Design Principles

This guide records the workbench's agreed design direction for implementation and review.
It applies to the browser UI; IM messages and static Boards need not reproduce its layout.
[Web Workbench](03-web-workbench.md) owns web behavior and data contracts;
[AGENTS.md](../../AGENTS.md) defines engineering boundaries.
These principles guide acceptance of changes, not a claim that every existing control complies.
Explicit user requirements take precedence. Explain changes to conventions and update the
relevant documentation; no separate default approval process is introduced.

## Information Hierarchy

Draw on the rounded shapes, layered materials, and natural transitions of iOS/macOS 26
within the web platform. Readability, clear state, and responsive interaction come first.
Primary content needs stable reading surfaces; controls can use lighter floating layers;
activity and metadata should support the conversation without competing with it.
Use spacing, size, placement, and contrast to establish hierarchy, not unreadable opacity.
Keep light and dark themes coherent, with visible focus and status conveyed beyond color.

## Content, Controls, and Materials

Use solid surfaces for replies, modal forms, search dialogs, and file previews.
The search palette is one: a solid panel with the floating chrome's edge and
raised shadow, flat rows whose keyboard selection is a tinted pill with medium
weight (no edge bar), sentence-case section labels, and a match marked by ink
and weight rather than a highlighter. Its rows use the desktop action scale:
0.9375rem labels in 2.5rem rows (44px on touch), each opening on a 1.75rem
Lucide tile that says what kind of thing it opens and gives the row its edge
— no rules between rows or groups, space and small heavy grey heads alone; the
detail sits beside the label as a 0.8125rem subtitle that gives way before the
label does; 0.75rem marks; the input is 1.0625rem in a 3.25rem band.
Reserve glass, subtle borders, and shadows for navigation and floating controls where they
clarify layering. Coordinate corner radii with nesting rather than imposing one radius everywhere.
Reuse the shared palette, controls, menus, and time labels instead of inventing page-specific styles.
The desktop sidebar uses one inset floating panel with restrained glass, border
and shadow; its rows stay flat, with selection expressed through tint and weight.
Floating chrome lifts off the canvas the macOS way: a canvas one step darker
than the panel, a neutral translucent hairline (light in dark mode), a top-edge
highlight, and a two-part shadow — wide ambient plus tight contact — shared by
sidebar, chat heading and menus through one glass token set; the composer and
the open drawer, which sit over content, take the same set one step raised.
Menus and popovers take that token set on a solid surface rather than a
translucent one: chrome is glanced at, but a menu is read — model ids, paths
and session actions are scanned over whatever scrolls behind them, and the
transcript coming through them is noise where there should be none.
The transcript runs the full pane and the heading and composer dock float over
it at every width, so rows scroll under the glass and dissolve at the pane's
edges rather than being cut at a chrome boundary; the pane pads its ends by what
covers them. Only which heading floats changes: the mobile top bar below md, the
chat heading above it, in the same slim inset rounded strip and the same glass —
and a phone's Console view, which brings its own title strip and scrollers,
starts below the bar instead of under it.
The session's meta chips — model, reasoning, context size, and the "starting…"
a session being opened has to say — are one element, hosted by whichever of the
two headings is on screen, and they leave with the chat heading when a Console
view takes over. This is the one place the phone needs its own answer: the chips
do not fit beside a session's name at that width, so the bar grows a second line
under the title for as long as there are chips, and the transcript pads by it.
The chips stay the desktop's shortcut into the model picker; the ⋯ menu is the
thumb-sized way to the same two actions.
Dock cards (queue, recovery) take the composer's own inset at both widths, and
their controls take the 44px touch target on a coarse pointer, growing the
card's header row rather than clipping it.
The mobile drawer keeps its available width and uses rounded outer corners
without desktop panel margins. A Console page's head — its title, tabs and
primary action on one band — is that same strip at both widths, so a Console
page and a chat read as one workbench. Keep the outer page edge neutral and
match installed-window theme metadata to that canvas in both themes, including
startup. Reserve the very pale
mist-blue and mint background accents for the lower conversation area so color
supports reading without tinting the entire workspace.
Action menus align labels without a reserved selection column; only selectable
options reserve checkmarks. Group related actions with restrained separators and
truncate secondary hints. Phone session sheets identify the target session and
provide a close control. Session details use a solid reading surface, a readable
title, grouped label/value fields and explicit navigation; reserve monospace for
technical identifiers and keep directory/ID copy controls reachable on touch.
Use the shared rem scale: 0.9375rem desktop / 1rem phone action labels with a
1.5rem line height; session info uses 0.9375rem body text at 1.5 line height,
1.125rem titles and 0.8125rem supporting text. Keep its desktop width to 26rem,
use tight field/group spacing and place relative times beside their timestamps
when space allows. Paths and IDs use 0.875rem
monospace with room to wrap. Phone sheets have a
backdrop that dismisses without activating controls underneath.
Model picker content fills its panel; long session titles truncate within a
bounded width. Keyboard focus leaving a nonmodal menu dismisses it so its
navigation keys cannot intercept interaction with background controls.
Reasoning effort uses an inline disclosure with styled native
radio choices, visible selection and keyboard focus, avoiding nested overlays.
A dialog hosting viewport-fixed menus must not use backdrop blur or transform animations:
these change the menus' containing block and can cause offsets or clipping. Keep menus in
its top layer, and clip only content that needs clipping. Verify actual overlay hit targets.

## Conversation and Activity

Give user messages a clearly bounded mist-blue surface with dark text and a corresponding
muted dark variant. Use alignment, fill, and outline to distinguish roles before reading text.
Assistant replies use a solid reading surface, with a comfortable width for long text.
Keep the final answer distinct from the work log. During a turn, progress text, thinking,
and tool activity belong in expandable steps before the reply bubble. Once the turn ends,
show the final text as the reply without duplicating it in steps or leaving empty activity groups.
Live rendering, restored history, and reconnection replay must tell the same story.
Aborted work retains readable unfinished text; errors, pending decisions, and states without
a reply remain explicit. Visual simplicity must never make something that happened disappear.
Activity history limits must not displace queued or running work from the live view.

System notices use wide neutral panels with visible outlines, distinct from conversation bubbles.
They prioritize the topic, especially on phones. Keep their bodies to four rendered
lines by default, with the full text available on expansion. IDs remain supporting details.
Use shared status meanings: cyan for delegation and callbacks, amber for decisions, and clear
success, failure, or interruption states for results. Keep color accents small and restrained.
Time separators provide context at the first user message, after a ten-minute gap, or across
dates, combining absolute and relative time. Essential context must not depend on hover.

## Editing and Form Structure

Only the latest user message is editable, even after an assistant reply. Place its edit control
beside the bubble, with discoverable touch and keyboard access and room on narrow screens.
Explain that sending an edit resends the question and replaces subsequent replies.
Editing must remain valid against current session state: reject stale or busy-session actions,
allow cancellation, and restore the server's actual history with a visible reason on failure.

Keep primary actions with the page heading or navigation, separate from filters.
For example, `New task` belongs beside the Tasks tabs, not inside the filter card.
Use visible labels and a consistent grid. Disclose secondary filters progressively, but always
make active conditions discoverable; an active date range expands and contributes to reset state.
URL state, reset, browser Back, and restored fields must agree. Background refreshes preserve
input, focus, scroll position, and interactions in progress. Compact screens still need room
for results, and long labels or date controls must not determine the page's width.

## Purposeful Motion

Motion explains feedback and spatial relationships. Keep it brief, restrained, and interruptible;
do not suppress all animation globally. Reuse existing easing and browser animation primitives.
Logical state changes immediately even when a visual exit continues: closing controls stop
accepting input, and cleanup cannot remove a replacement or leave an invisible blocking layer.
Rapid reversals continue from the visible state. Animate deliberate changes, not every streaming
update, background refresh, or restored message. Preserve the reader's position unless they
are already following the bottom of the conversation.
Honor reduced-motion preferences with short fades and less movement or scaling; reduced
transparency and increased contrast call for solid surfaces. Unsupported animation features
may fall back to instant changes while retaining content, native semantics, and keyboard access.

## Shared Foundations and Validation

Keep one source of truth: existing snapshots, events, activity types, and status mappings.
Presentation must not introduce parallel records. Extend shared primitives, remove obsolete
styles, and consolidate repeated logic without speculative abstractions or new frameworks.
Use native controls and semantics, readable contrast, visible focus, and generous touch targets.
Workbench control, disclosure and status icons use Lucide's 24-unit viewBox and 2-unit
rounded strokes, with `currentColor`; use named imports through `ui/icons.ts`, never
hand-drawn SVG or Unicode substitutes. Default icons are 0.875rem, compact disclosures
and status marks 0.75rem; icon size must not shrink the surrounding hit target. Decorative
SVGs are hidden from assistive technology; the control retains its text or accessible
label, and selected/loading/error states keep their existing state and text. The Pier
brand, data graphics, keyboard shortcut notation and symbols in actual content stay intact.
Account for safe areas and software keyboards; content panels own scrolling, and wide content
must not force the whole conversation to scroll horizontally. Navigation titles
keep their left edge aligned. Trailing status marks occupy space only when
present; actions also reclaim their width when hidden. Hover and keyboard focus
reveal desktop row actions; touch keeps the current session's action visible.
Titles may truncate earlier while these controls appear, but their left edge
stays aligned. The labeled New session action and a distinct magnifier share a
row: New session has the primary blue fill and Search a muted neutral fill with
contrasting icon. Search retains an accessible name and
shortcut hint. Row actions remain
reachable by keyboard and touch, with 44px minimum touch targets. A closed mobile
drawer is inert; an open drawer owns keyboard focus, supports Escape, and returns
focus on dismissal. Sidebar type uses the system sans-serif stack, sentence-case
section labels and medium-weight selection. Desktop rows use a denser reading
rhythm than the touch drawer; keep section gaps restrained, titles on one line
and sessions in their own scrolling list.

Validate the behavior affected by a change: normal use, failure, cancellation, interruption,
loading, and reconnection. Exercise keyboard, pointer, touch, narrow and wide viewports,
light and dark themes, and relevant accessibility preferences. Check rapid interaction and
real hit targets as well as appearance; screenshots alone cannot establish correctness.
Run relevant code checks for implementation changes; documentation changes need content and
link checks. Use isolated mock data without sending real tasks or changing production services.
Report actual browser coverage, especially for glass, dialogs, transforms, and native controls.
Chromium emulation is not native Safari / iOS verification. Record specific gaps and fix them
within the affected controls rather than expanding into unrelated refactors.

[Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials) and
[Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion) inform the
visual direction; this guide and user decisions govern the web behavior Pier adopts.
