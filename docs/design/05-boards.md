# Boards (product spec)

A **Board** is a folder of static files an agent writes to present something at
a stable URL, readable on a phone, with no server-side runtime. Every surface
is behind the instance password (`src/web/auth.ts`); `/p/*` (published boards
plus the stylesheet they link) and `/b/*` (the signed prefix `/boards/*`
redirects to once the password has been spent) are exempt — the other
exemption is `/config-sync/:token`, not a board — so `public` is a security
boundary.

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

## Routes (`src/boards/boards.ts`, ≤ 240 lines of code incl. the filesystem side)

| Route | Behavior |
| ----- | -------- |
| `GET /api/boards` | scan + list `{slug, title, description, sessions, public, token, updatedAt}` |
| `PATCH /api/boards/:slug` | body `{public}` → write `board.json`, minting `token` on the first publish; every other field is agent-owned |
| `DELETE /api/boards/:slug` | rename to `<slug>.deleted-<ts>` in place |
| `GET /p/_assets/pier.css` | the shipped stylesheet |
| `GET /boards/:slug/*` | the operator surface: 404 if the board is gone, else 302 to `/b/:slug/:view/*`, path and query kept |
| `GET /b/:slug/:view/*` | static from `<board>/site/`, **only** if `view` is a live signature for that slug; otherwise 302 back to `/boards/:slug/*`, path and query kept |
| `GET /p/:slug-:token/*` | static from `<board>/site/`, **only** if `public: true` and the token matches; otherwise 404 (never 403 — do not leak existence) |

`token` is 32 random bits, minted the first time a manifest is seen public (by
the Console's toggle or by `readManifest` when an agent set `public: true`).
The flag decides; the token only hides the door.

`view` is `<expiry in base36>-<HMAC(slug, expiry) truncated to 128 bits>`,
signed with a process-scoped key and valid for 8 hours. Its own path segment,
so the first hyphen is the cut and a hyphenated slug stays unambiguous; the
stamp must be the canonical base36 of the expiry it signs, or one signature
would be valid under several spellings. The key is rotated on every session
revocation (`main.ts`) and after a delete (a slug can be taken again), because
the page carries no cookie a sign-out could end. A dead prefix is not a 404: it
redirects to `/boards/:slug/*`, so a live session re-mints in one hop and a
stranger meets the login form.

A `/b/` URL is a bearer credential for one board until it expires: copied out
of the address bar it reads that board without the password, and the Public
toggle does not revoke it. The Console's Private section says so.

Both static handlers: realpath containment against `<board>/site`, extension
whitelist extended with `html/css/js/svg/woff2/ico`, no directory listing,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (the URL is
the credential on both prefixes), `Cache-Control: no-store` (every board URL is
revocable, and a stored copy would outlive the revocation),
`Access-Control-Allow-Origin: *` (an opaque
origin needs CORS for its own fonts and modules), and a CSP of `sandbox
allow-scripts; default-src 'self'; img-src 'self' data:; style-src 'self'
'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none';
frame-ancestors 'none'`.

No board gets `allow-same-origin`, published or not — the page is agent-written
script, and on the workbench origin it would read that origin's `localStorage`
and carry what it read out by top-level navigation, which no CSP directive
removes. The signed prefix exists to pay for that: an opaque-origin document
sends no `SameSite=Lax` cookie with its own sub-resources (verified in
Chromium), so a cookie-authorized board URL would 302 its own stylesheet and
images to `/login`.

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
