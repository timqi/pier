# Boards (product spec)

Renames avibe's "Show pages". A **Board** is a folder of static files that an
agent writes to present something — a report, a dashboard, a digest, a handover
note — at a stable URL, readable on a phone, with no runtime.

Authentication has since shipped (`src/web/auth.ts`): every surface is behind
the instance password, `/p/*` and the board stylesheet are the only
exemptions, so `public` is a real security boundary — the design below
predates that and holds unchanged.

## Product decisions

1. **A board is a directory, not a record.** `$PIER_HOME/boards/<slug>/`, served
   from its `site/` subdir. The filesystem is the source of truth; boards are
   *derived* by scanning, exactly like Projects are derived from session cwds.
   No table, no store, no migration.
2. **Lifecycle is independent of sessions.** A board links 0..n sessions and a
   session appears on 0..n boards (many-to-many, kept in the board's manifest).
   The link is provenance — "here is the context this was produced from" — never
   a lifetime: closing, compacting or deleting a session leaves the board
   untouched. Any session may read, edit and publish any board.
3. **Private unless asked.** `public` is an ordinary agent-writable field in
   `board.json`, default `false`. The agent may set it — but only when the user
   asked for a public board in that request; absent an explicit ask it stays
   private, and the skill states this as a rule, not a preference. The Console
   can flip it either way and lists every public board in one place, so a misread
   intent is visible at a glance.
4. **HTML only.** Markdown is worse exactly where boards earn their keep — KPI
   rows, two-column layouts, inline-SVG charts, `<details>` folds — so there is
   no markdown source, no renderer, no content negotiation. Other sessions read
   the files directly, which is what "machine readable" means on a local machine.
5. **The hard rule is on the artifact: static and self-contained.**
   `site/index.html` plus relative paths under `site/`, zero network at view time
   (the CSP enforces it), no server-side execution.
6. **No build system, and Pier ships no toolchain.** A board is hand-written HTML
   against one shipped stylesheet; that is the whole authoring story. Tailwind
   and bundlers earn their keep in multi-component apps, not on a single content
   page, where a `<style>` block or one CSS file is equal or better at zero cost.
   A board that genuinely needs a build brings its own (`npx` whatever, sources
   wherever it likes, output into `site/`) and explains it in `README.md` —
   Pier contributes no code, no pinned toolchain, no CLI to that path. If a third
   board proves it needs the same build, that is when a shared one gets designed.
7. **Only `site/` is served.** `board.json`, `README.md` and any sources a board
   keeps are unreachable over HTTP — that is what keeps a build config or a stray
   note off a public board. Pier never runs anything for a board: an agent builds
   in its session. A web surface that executed board scripts would be a shell
   hole.
8. **Cheap to serve.** Static bytes off disk. Board count and board size have no
   effect on the rest of Pier; an over-detailed board is only a big folder.
9. **No JS framework, anywhere near this feature.** React on a board means a
   bundler, hydration and tens of KB of runtime so that a page of text can break
   when JavaScript is off. Genuinely rich interaction is one board bundling one
   small library — never a Pier-wide framework decision. The Console's boards
   view is a table, which is not a reason to change Pier's own no-framework
   stance.

## On-disk layout

```
$PIER_HOME/boards/
  weekly-digest/                  # the normal case: hand-written, no build
    board.json
    site/index.html               # the only served directory
    site/assets/…
  infra-dashboard/                # rare: brings its own build
    board.json
    README.md                     # how to rebuild, where the data comes from
    src/ …                        # sources — never served
    site/…                        # its build output
  weekly-digest.deleted-1739…/    # deletes rename in place; the slug rule hides them
```

`board.json` — four fields, nothing derivable:

```json
{
  "title": "Weekly digest — infra",
  "description": "What changed in infra this week and what needs a decision.",
  "sessions": ["01JD…", "01JE…"],
  "public": false
}
```

Slug: `[a-z0-9][a-z0-9-]{0,63}`. Anything else, and any directory with a missing
or unparsable `board.json`, is logged once and skipped — never half-listed.
Timestamps come from the filesystem (`site/` mtime), not the manifest.

## Shipped stylesheet (`/boards/_assets/pier.css`)

Served from Pier's package dir, not from `$PIER_HOME`, so an agent cannot edit it
and every board upgrades at once. One **classless** stylesheet: readable measure,
mobile-first, system font stack, styled
`h1-h4 / p / ul / table / blockquote / pre / code / hr / details` (zebra rows
included) and a `prefers-color-scheme` dark block. Plain semantic HTML looks
finished with zero classes and zero setup — which is exactly why no build is
needed.

On top of that, presentation helpers, because a board *is* a presentation and a
monochrome wall of text was the first thing daily use complained about: a
semantic palette (`--good/--warn/--bad`), `.lede`, `.grid` + `.card` + `.kpi`
for a KPI row, `.callout` for the takeaway, `.tag` status pills, `.num` numeric
cells and `.bar` — a CSS proportion bar that covers "share of total" without a
chart library. Each has a status variant. The skill teaches them as a table and
sets the rules: colour encodes meaning and always pairs with a word, two or
three accents per page, structure (table/KPI/callout) before graphics, a chart
only when the data's *shape* is the message.

Offered, not imposed: a board may ship its own CSS. There is no blessed class
list and no linter; house style comes from the skill's skeleton and this
stylesheet being good enough, not from policing.

## Routes (`src/boards/boards.ts`, ≤ 200 lines of code incl. the filesystem side)

| Route | Behavior |
| ----- | -------- |
| `GET /api/boards` | scan + list `{slug, title, description, sessions, public, updatedAt}` |
| `PATCH /api/boards/:slug` | body `{public}` → write `board.json`; every other field is agent-owned |
| `DELETE /api/boards/:slug` | rename to `<slug>.deleted-<ts>` in place |
| `GET /boards/_assets/pier.css` | the shipped stylesheet |
| `GET /boards/:slug/*` | static from `<board>/site/`, public or not — the operator surface |
| `GET /p/:slug/*` | static from `<board>/site/`, **only** if `public: true`; otherwise 404 (never 403 — do not leak existence) |

Both static handlers: realpath containment against `<board>/site` (reuse the
`src/web/server.ts` attachment pattern), extension whitelist extended with
`html/css/js/svg/woff2/ico`, no directory listing, `X-Content-Type-Options:
nosniff`, and on `/p/*` a CSP of `default-src 'self'; img-src 'self' data:;
style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';
connect-src 'none'; frame-ancestors 'none'` — a public board cannot phone home.

One module owns scan, manifest read/write, rename-delete and the routes; at this
size splitting store from routes would be copying `tasks/`'s shape rather than
answering a need. `readManifest` is the single place a slug becomes a path, so it is the
single place a slug is validated — every route reaches the filesystem through
it. `src/boards/` depends on `node:fs` and core types only;
`main.ts` registers it next to the task routes.

## Console surface (`src/web/ui/boards.ts`)

One table, nothing else: public boards in a section at the top with their
copyable `/p/<slug>/` URL, then the private ones — title · slug · linked sessions
(links into chat) · updated, with a public toggle, open ↗ and delete. The toggle
carries a one-line "anyone with the link can read this" warning.

No detail drawer, no title/description editing, no file list, no board picker in
the session menu: the manifest belongs to agents, and the Console's job is the
one decision a human owns (publish) plus clutter removal. Refetch after own
actions and on window focus; SSE auto-reload of an open board is backlogged.

## Agent surface (`skills/pier-boards/SKILL.md`)

No new tool — boards are files and the agent already has file tools. The skill
carries the directory contract (`site/` is served, everything else is not), the
four manifest fields (including "add your own session id to `sessions`"), the
slug rule, the `pier.css` URL, a copy-paste HTML skeleton, the publish rule
("`public: true` only when the user asked for a public board in this request;
otherwise leave it false and say where the board is"), and:

- write HTML by hand against `pier.css`; no build, no npm, no framework;
- if a board truly needs a build, keep sources outside `site/`, write a
  `README.md` a cold session can follow (install, build, output path, where the
  data comes from), and never leave `site/` inconsistent with them;
- before editing an existing board, look for `README.md` and sources and go
  through them — hand-patching `site/` on a built board is lost on the next
  build.

Style guide:

- one page, top-down: what this is → the answer → supporting detail → raw data in
  `<details>`;
- text and tables beat charts; a chart is inline SVG unless the data's shape is
  genuinely the point;
- interaction is `<details>` and anchors; keep the page readable with JavaScript
  off;
- mobile-first, no horizontal scroll, no fixed widths, no external requests;
- prose in the reader's language, headings short, no emoji chrome;
- rewrite a board in place across sessions rather than versioning by slug.

Shipped in the existing `skills/` dir that `PiAgentFactory` already loads, so it
costs one description line of context until a session needs it. (There is no
`boards.enabled` flag: adding a config system for one folder-based feature would
cost more than the feature.)

## Tests

- Filesystem units in a tmp `PIER_HOME`: slug validation, malformed manifest is
  skipped + logged (and treated as private), manifest write round-trips, delete
  renames and disappears from the scan.
- Route tests: `/p/:slug` 404 while private and 200 after `public: true`; `..`,
  absolute-path and symlink escapes rejected on both static prefixes;
  `board.json`, `README.md` and sources are 404 under both prefixes even though
  they sit in the board dir.

## Acceptance

- An agent creates a board with plain file writes, links its session, and the
  Console lists it within one refetch.
- A board created without an explicit public request is unreachable at
  `/p/<slug>/`; setting `public: true` (agent or Console) makes it reachable and
  lands it in the Console's public section.
- A second, unrelated session edits the same board's content and description.
- Deleting the linked session changes nothing about the board.
- The board reads well on a phone with JavaScript disabled.
