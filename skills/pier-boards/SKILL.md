---
name: pier-boards
description: Publish a Board — static HTML at a stable Pier URL. Read before creating or editing a page-shaped deliverable (report, digest, dashboard).
---

# Boards

Use the exact boards folder and instance address in "This Pier instance" in
`<pier>/AGENTS.md`, not an assumed `~/.pier`. Only `<slug>/site/` is served;
boards persist across sessions. Update existing boards in place, preserving URLs.
Before editing, read the board's README if present; change sources and rebuild.

## Files and visibility

Create `<boards folder>/<slug>/board.json` and `site/index.html`:

```json
{"title":"Weekly digest","description":"What changed and needs a decision","public":false}
```

Slug: `[a-z0-9][a-z0-9-]{0,63}`, meaningful without random suffixes. Description
is one line on what the board is for.

`public: true` removes the password. Set it only when this request asks for a
public/shareable board; otherwise keep it private. Never publish personal data
or content the user has not seen. Preserve the manifest's token; if missing,
generate eight hex characters with `openssl rand -hex 4`, never invent/reuse one.

Return one bare URL using the configured instance address:

- Private: `/boards/<slug>/` (password required).
- Public: `/p/<slug>-<token>/` (copy the token verbatim; requires `public: true`).

Never return both URLs, link labels or filesystem paths. Without a configured
address, return the path and point to Console → Settings; never guess a host.
For publish-only requests, set visibility/token and return the URL; skip layout
checks and narration.

## Answering the user

- List: read every `<boards folder>/*/board.json` (skip names with
  `.deleted-`); public boards first with `/p/<slug>-<token>/`, then private
  with `/boards/<slug>/`; one row each, title and how long ago `site/` changed.
- Publish or unpublish: set `public` in `board.json` by the token rule above,
  keep every other field, and answer with the resulting URL.
- When publishing, say: "anyone with the link can read it".
- Delete: rename the directory to `<slug>.deleted-<unix ms>`; never remove it.

## Page

Semantic HTML, the user's language, no framework. Include doctype, `lang`, UTF-8,
viewport metadata, a descriptive title and:

```html
<link rel="stylesheet" href="/p/_assets/pier.css">
```

- Lead with the finding; headings state findings. No required sections or emoji chrome.
- Match the form to the evidence: prose for explanations, cards for metrics,
  tables for comparisons (problems first), timelines for events. Use units,
  baselines and honest precision; every number needs evidence or an explicit
  illustrative calculation. Label uncertainty and stale/unverified claims.
- Put decisions and evidence first; fold supplementary detail with `<details>`.
  End with data date, checkable sources and refresh instructions, not a recap.
- No secrets, credentials, internal hostnames or private paths, even in folds:
  private boards can become public with one edit.
- Assets belong under `site/`, using relative URLs except the shared stylesheet.
  Illustrate freely with inline SVG or images you draw, render or save into
  `site/`: CSP allows `img-src 'self' data:`. No CDN, external fonts, analytics
  or network fetches; board CSP blocks them.
- Prefer native links/disclosures. Local JS may sort/filter embedded data;
  keep content readable without JS and hide/disable unavailable controls.
- Charts must explain something; prefer inline SVG with text/table fallback,
  or a small bundled library only when interaction helps.

## Layout and type

Inherit the shared responsive canvas: wide desktop, padded/reflowing phone.
The container is the reading measure: text runs its full width and every
sibling block shares the same two edges. Do not lock the page, a section or a
paragraph to a narrower article width unless requested; `.prose` caps the
column on an ultrawide canvas and belongs on one page-level wrapper, never on
chapters alternating with full-width blocks.

Use the shared system fonts and palette; no downloaded fonts. Body defaults to
17px/1.7, headings to serif, KPI numbers to body type. Sans-serif headings are an
optional page choice; code identifiers use monospace, formulas body/math type.
Preserve contrast and avoid long unbroken identifiers widening grids.

Wrap tables in a labeled, keyboard-focusable scrolling region:

```html
<div class="table-scroll" role="region" aria-label="Comparison" tabindex="0">
  <table>…</table>
</div>
```

Use native table layout; add a table minimum width only when columns would become
unreadable on phones. Reuse helpers before adding CSS:

| Helpers | Purpose |
| --- | --- |
| `.hero`, `.lede` | opening panel, answer |
| `.grid`, `.card`, `.kpi` | responsive metric cards |
| `.split` | two columns that stack |
| `.prose`, `.table-scroll` | page reading column, scrollable table |
| `.callout`, `.tag`, `.muted` | takeaway, status, supporting text |
| `.num`, `.bar` | aligned numbers, proportion (`style="--v:62%"`) |

`.good` / `.warn` / `.bad` express status with words as well as color;
`.info` is available on cards/tags. Custom CSS must retain phone reflow and
contrast; do not copy shared helpers into pages once the deployed CSS has them.

## Verify

For layout/interaction changes, check phone/desktop and light/dark: aligned block
edges, readable line lengths/contrast, no page overflow (including long code),
tables scroll internally. Exercise keyboard/touch, visible focus and usable
targets; check assets/console and JS-off readability. Report actual browser
coverage and gaps; Chromium emulation is not Safari/iOS. For content-only edits,
check changed content and links.

If a build is necessary, keep sources outside `site/`, emit into `site/`, and
record install/build commands, output path and data sources in `<board>/README.md`.
Pier ships no build toolchain.
