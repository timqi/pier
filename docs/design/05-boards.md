# Boards (product spec)

A **Board** is a folder of static files an agent writes to present something at
a stable URL, readable on a phone, with no server-side runtime. Every surface
is behind the instance password (`src/web/auth.ts`); `/p/*` (published boards plus the
stylesheet they link) is the only exemption, so `public` is a security boundary.

## Product decisions

1. A board is a directory, `$PIER_HOME/boards/<slug>/`, served from `site/`;
   derived by scanning — no table, no store, no migration.
2. Lifecycle is independent of sessions: a board links 0..n sessions (in its
   manifest) as provenance, never as a lifetime. Any session may read, edit and
   publish any board.
3. Private unless asked: `public` defaults `false`; the agent sets it only when
   the user asked for a public board in that request. The Console can flip it
   and lists every public board in one place.
4. HTML only: no markdown source, no renderer, no content negotiation.
5. Static and self-contained: `site/index.html` plus relative assets under
   `site/` and the shipped stylesheet; no external resources, network data
   requests or server-side execution.
6. No build system; Pier ships no toolchain. A board that needs a build brings
   its own (output into `site/`) and explains it in `README.md`.
7. Only `site/` is served; `board.json`, `README.md` and sources are
   unreachable over HTTP. Pier never runs anything for a board.
8. Static bytes off disk; board count and size do not affect the rest of Pier.
9. No JS framework: local scripts may enhance embedded data, using a small
   bundled library when needed; the answer and evidence remain readable with
   JavaScript off, and unavailable controls are hidden or disabled.

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

## Shipped stylesheet (`/p/_assets/pier.css`)

[`pier.css`](../../src/boards/pier.css) is served from Pier's package directory;
it styles semantic HTML with responsive widths, dark mode and optional helpers.
The [skill](../../skills/pier-boards/SKILL.md) owns their usage and presentation
guidance: content determines layout, status has text labels, graphics serve
understanding. Custom CSS must preserve contrast and phone reflow; no linter.

## Routes (`src/boards/boards.ts`, ≤ 200 lines of code incl. the filesystem side)

| Route | Behavior |
| ----- | -------- |
| `GET /api/boards` | scan + list `{slug, title, description, sessions, public, token, updatedAt}` |
| `PATCH /api/boards/:slug` | body `{public}` → write `board.json`, minting `token` on the first publish; every other field is agent-owned |
| `DELETE /api/boards/:slug` | rename to `<slug>.deleted-<ts>` in place |
| `GET /p/_assets/pier.css` | the shipped stylesheet |
| `GET /boards/:slug/*` | static from `<board>/site/`, public or not — the operator surface |
| `GET /p/:slug-:token/*` | static from `<board>/site/`, **only** if `public: true` and the token matches; otherwise 404 (never 403 — do not leak existence) |

`token` is 32 random bits, minted the first time a manifest is seen public (by
the Console's toggle or by `readManifest` when an agent set `public: true`).
The flag decides; the token only hides the door.

Both static handlers: realpath containment against `<board>/site`, extension
whitelist extended with `html/css/js/svg/woff2/ico`, no directory listing,
`X-Content-Type-Options: nosniff`, and on `/p/*` a CSP of `default-src 'self';
img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'
'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'`.

One module owns scan, manifest read/write, rename-delete and the routes.
`readManifest` is the single place a slug becomes a path and is validated;
every route reaches the filesystem through it. Depends on `node:fs` and core
types only; registered in `main.ts` next to the task routes.

## Console surface (`src/web/ui/boards.ts`)

One list: public boards first with their copyable `/p/<slug>-<token>/` URL,
then private. A row: title (links to the board); slug, description, updated
time, linked sessions (links into chat), public URL on a wrapping meta line;
public toggle (with an "anyone with the link can read this" warning), copy
link, delete — the hover-revealed two stay visible on touch. Below md the title
takes its own line and controls wrap under it; the head strip is desktop-only.
No detail drawer, no title/description editing, no file list, no board picker
in the session menu. Refetch after own actions and on window focus.

## Agent surface (`skills/pier-boards/SKILL.md`)

The bundled skill covers creation, publishing, presentation and verification
through file operations; `PiAgentFactory` loads it from `skills/`, with no new
tool or `boards.enabled` flag.

## Tests

- Filesystem units in a tmp `PIER_HOME`: slug validation, malformed manifest is
  skipped + logged (and treated as private), manifest write round-trips, delete
  renames and disappears from the scan.
- Route tests: `/p/:slug` 404 while private and 200 at `<slug>-<token>` after
  `public: true`, 404 on a missing or wrong token; `..`,
  absolute-path and symlink escapes rejected on both static prefixes;
  `board.json`, `README.md` and sources are 404 under both prefixes even though
  they sit in the board dir.

## Acceptance

- An agent creates a board with plain file writes, links its session, and the
  Console lists it within one refetch.
- A board created without an explicit public request is unreachable at
  `/p/<slug>-<token>/`; setting `public: true` (agent or Console) makes it reachable and
  lands it in the Console's public section.
- A second, unrelated session edits the same board's content and description.
- Deleting the linked session changes nothing about the board.
- New pages and layout/interaction changes pass the skill's phone/desktop,
  theme, keyboard/touch, asset and JavaScript-disabled checks; content-only
  edits check the affected content and links, with actual coverage or gaps reported.
