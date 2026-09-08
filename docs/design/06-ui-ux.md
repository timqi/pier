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
Reserve glass, subtle borders, and shadows for navigation and floating controls where they
clarify layering. Coordinate corner radii with nesting rather than imposing one radius everywhere.
Reuse the shared palette, controls, menus, and time labels instead of inventing page-specific styles.
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
Account for safe areas and software keyboards; content panels own scrolling, and wide content
must not force the whole conversation to scroll horizontally. Navigation titles
keep their geometry when status or hover actions change. Primary sidebar actions
have visible labels; row actions remain reachable by keyboard and touch, with
44px minimum touch targets. A closed mobile drawer is inert; an open drawer owns
keyboard focus, supports Escape, and returns focus on dismissal.

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
