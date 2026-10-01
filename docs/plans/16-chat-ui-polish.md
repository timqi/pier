# Chat polish — seven rendering and layout corrections

## Scope

Implement the user-approved priority list against `/tmp/pier-chat-1985dn0m/review.md` and its screenshots; Files preview layout is excluded. Preserve existing event state, controls, desktop bubble sizing and failure visibility.

1. Fix CJK strong emphasis in `dom.ts` `markdownBox`, with focused regression tests for punctuation, adjacent text, escaped markers and code.
2. Render callback/task result bodies as safe Markdown; keep prompts and technical input plain, remove duplicate callback state labels, and preserve local `/tmp` image URLs through attachment rewriting.
3. Make topic labels readable on both themes and user/assistant materials using the existing topic colour and CSS colour mixing.
4. Give phone assistant bubbles the available width; wrap tables in horizontal scrolling containers, with content-sized tables, bounded cell widths and a subtle overflow cue. Short tables remain compact.
5. Put multiline composer actions on a bottom row without oscillating layout as wrapping changes; retain IME, send, cancellation and safe-area behavior.
6. Enlarge single-image previews with reserved aspect-ratio space; retain contain, compact multiple-image strips and the lightbox.
7. Strip Markdown from displayed quote excerpts without changing source matching or the quote wire format.

## Execution

- One sequential balanced implementation worker owns the shared rendering/CSS files, avoiding conflicting parallel changes.
- Update `docs/design/06-ui-ux.md` and `03-web-workbench.md` only for changed contracts.
- Lead validates the integrated implementation through browser checks, then opens a review goal in this worktree. Fix findings and stop before merging.

## Acceptance

- Focused rendering regression tests plus `npm run check && npm run lint && npm test`; web build succeeds.
- Desktop Chrome screenshots for desktop/390px, light/dark: CJK emphasis, callback Markdown/local images, topic labels, short/wide tables, multiline composer, single image and quotes.
- Use an isolated local preview with mock data; no production writes, restart, deploy or real task submissions for UI testing. Reuse logged-in desktop Chrome where appropriate.
- Exercise table horizontal scrolling, composer growth/shrink/quote cancellation and lightbox open/zoom/Escape; explicitly report untested native iOS keyboard/touch behavior.
- Final state committed and clean, with review goal, SHA, screenshot evidence and worktrees retained for supervisor/user.

## State

Implemented on `chat-ui-polish`; accepted in desktop Chrome (emulated 390x844 and 1440x1000, light and dark) against a mock-API preview of the built UI — report `/tmp/pier-chat-polish-verify/report.md`, screenshots beside it.

- CJK emphasis: a `cjkStrong` marked inline extension on both instances (`dom.ts`), firing on CJK beside either marker or at either inner edge; `core/reply.ts` `cjkFriendly` untouched for IM.
- Callbacks: the body is `renderMarkdown` against the child session and cwd; delegation/task-message/command bodies stay plain; a cause card's head drops the chip's glyph and `kind · state`. `rewriteFileLinks` also routes bare absolute paths under a filesystem root; an attachment in a table cell stays in the cell.
- Topic text: `color-mix(in oklab, var(--topic), var(--color-neutral-900) 40%)`.
- Phone/tables: assistant `max-width: 100%` below md; chat tables (`textOnly` renderer) in `.table-scroll`, a focusable `region` named `Table`, with `max-content` columns, 18rem cells and scroll-shadow fades; Files tables unchanged.
- Composer: `data-multiline` on the input row, decided at the one-line width with the scrollbar hidden, on input and on a change of the row's width.
- Images: `.thumbs > .thumb:only-child` 4:3, `width: 17.5rem; max-width: 100%`, contain; tiles in table cells and multi-image strips unchanged.
- Excerpts: `excerptText(excerpt, role)` shows a reply's markdown through `plainText`; quote wire format and source matching unchanged.
- Verified: `npm run check`, `npm run lint`, `npm test` (1967 passed), `npm run build:web`; all seven items pass in the browser, with interaction checks for tables, composer resize and quote cancel, lightbox, and quote jumps; no console errors; topic contrast ≥4.70:1 composited over a 1° hue sweep.
- Limitations: IME checked with synthetic composition events only; horizontal wheel scrolling of tables not driven (keyboard was); native Safari/iOS, physical keyboard and Firefox unverified.
- Review: the table box was made Tab-reachable and named, and CJK before the opener now fires (`运行**`npm test`**`); both re-verified in the same harness. A wrapped draft's height is the full-width measure (390px: 150 chars 119px box = 119px wide need, narrow 171px), pinned by a composer test. A callback's bash or JSON result also renders as markdown, so stdout's single newlines fold — the browser cannot tell a result's kind.
