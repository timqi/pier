# Boards (product spec)

A **Board** is a folder of static files an agent writes to present something at
a stable URL, readable on a phone, with no server-side runtime. Every surface
is behind the instance password (`src/web/auth.ts`); `/b/*` (the signed prefix
`/boards/*` redirects to once the password has been spent, and the stylesheet
a board links) is exempt — the other exemption is `/config-sync/:token`, not a
board. A public board is not served by Pier at all: `pier boards publish`
copies every `public: true` board's `site/` to one Cloudflare Pages project,
so `public` is a security boundary and the Pages snapshot is the public surface.

## Product decisions

1. A board is a directory, `$PIER_HOME/boards/<slug>/`, served from `site/`;
   the folder is the index — no table, no store, no migration.
2. Lifecycle is independent of sessions: any session may read, edit, publish
   and delete any board.
3. Private unless asked: `public` defaults `false`; the agent sets it only when
   the user asked for a public board in that request.
4. The agent is the surface: listing, publishing, unpublishing and deleting are
   file operations the skill describes, plus one command, `pier boards
   publish`, after any change to what is public; a requested list puts public
   boards first with their `url`, then private boards, each with title and
   age. Publishing says anyone with the link can read it. Settings → Boards
   ([03](03-web-workbench.md)) holds the Pages project, runs the same publish
   (Publish), lists every board with its state, and writes only the delete rename.
5. HTML only: no markdown source, no renderer, no content negotiation.
6. Static and self-contained: `site/index.html` plus relative assets under
   `site/` and the shipped stylesheet; no external resources, network data
   requests or server-side execution.
7. No build system; Pier ships no toolchain. A board that needs a build brings
   its own (output into `site/`) and explains it in `README.md`.
8. Only `site/` is served; `board.json`, `README.md` and sources are
   unreachable over HTTP. Pier never runs anything for a board.
9. Static bytes off disk; board count and size do not affect the rest of Pier.
10. No JS framework: local scripts may enhance embedded data, using a small
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

`board.json` — nothing derivable; `url` and `publishedAt` are written by
`pier boards publish` alone:

```json
{
  "title": "Weekly digest — infra",
  "description": "What changed in infra this week and what needs a decision.",
  "public": true,
  "url": "https://pier-g1.pages.dev/weekly-digest/",
  "publishedAt": "2026-10-08T07:00:00.000Z"
}
```

Slug: `[a-z0-9][a-z0-9-]{0,63}`. Anything else, and any directory with a missing
or unparsable `board.json`, is logged once and 404s — never half-served.
Timestamps come from the filesystem (`site/` mtime), not the manifest.

`public` is the intent, `url` the fact: a board has a `url` exactly when it is
in the live Pages snapshot. Every surface names the state the two make:

| `public` | `url` | state |
| --- | --- | --- |
| false | — | `private` |
| true | yes, `publishedAt` ≥ `site/` mtime | `published` |
| true | yes, `site/` newer than `publishedAt` | `published · changes unpublished` |
| true | — | `publish pending` |
| false | yes | `unpublish pending` |
| folder renamed `<slug>.deleted-<ts>` | yes | `deleted · still live` |

`GET /api/boards` lists a `.deleted-*` folder while it carries a `url`, as
`deleted: true`; the next publish takes the `url` away and it leaves the list.

`withdrawnAt`, written only by the publish that takes a board down, is the
deploy's end; it is not a state and no surface shows it.

## Publishing (`src/boards/publish.ts`)

`pier boards publish` — from an agent's or the operator's shell, or as
Console → Boards → Publish in Pier's own process — is the only thing that
changes what is public. Settings (Console → Boards): `pagesProject`, the
Cloudflare Pages project — `[a-z0-9][a-z0-9-]{0,57}`, empty means this
instance publishes nothing, one project per instance (two instances on one
name overwrite each other, undetected) — and `pagesUrl`, the custom domain
when one is bound, else `https://<pagesProject>.pages.dev`. `wrangler` is
whichever is first on the publisher's PATH — the shell's, or the service's for
the button — and its credentials are the operator's (a credential shim such as
vt's injects them per call); Pier does not depend on it, never reads, stores or
passes a Cloudflare token, and never calls Cloudflare.

1. `POST /boards` on the CLI socket → `{project, base}`; no session needed,
   so it runs from any shell of Pier's user; a `422` is one `boards:` line,
   exit 1.
2. Scan `$PIER_HOME/boards` with the same manifest validation; `public: true`
   with a `site/index.html` goes in; one without prints
   `boards: <slug>: no site/index.html, skipped`.
3. A temp snapshot: `<slug>/` ← `site/` only (never `board.json`, `README.md`,
   sources), `b/_assets/pier.css` ← the shipped stylesheet, `_headers` =
   `Content-Security-Policy: connect-src 'self'; frame-ancestors 'none'` and
   `X-Content-Type-Options: nosniff` on `/*`. No index at the root: `/` is
   Pages' 404. `publishedAt` is taken here, before the upload. `_redirects`
   sends `/<slug>/` and `/<slug>/*` to `/` (302) for every slug not in the
   snapshot that has a `url` or a `withdrawnAt` under 7 days old; none, no file.
4. `wrangler pages project list --json` lacks the project →
   `wrangler pages project create <project> --production-branch main`.
5. `wrangler pages deploy <tmp> --project-name <project> --branch main
   --commit-dirty=true`, cwd the snapshot (wrangler's `.wrangler/` cache lands
   there); output streams through; the deployment hash is read off its URL.
6. `wrangler pages deployment list --project-name <project> --json`; every
   deployment older than this one is `deployment delete <id> --force`d —
   never a newer one, so two publishes racing cannot delete each other's.
7. Manifests: each board in the snapshot gets `url` = `<base>/<slug>/` and
   `publishedAt`, and loses `withdrawnAt`; every other manifest with a `url`,
   `.deleted-*` included, loses `url` and `publishedAt` and gets `withdrawnAt`;
   a `withdrawnAt` 7 days old goes; a leftover `token` goes on every path; a
   manifest that would not change is not written.
8. The snapshot is removed. Output: `published <url>` / `removed <slug>` per
   board, then `deployment <hash>, <n> older deleted`.

Any wrangler step failing: its output, `boards: <step> failed`, exit 1, and
no manifest written — step 7 runs only after a successful deploy. Step 6
failing is `boards: <k> older deployments not deleted — <slugs> may still be
reachable at their hash URLs`, exit 1, with step 7 still written, because the
live snapshot did change. No public board at all deploys a snapshot of only
`_headers`, the stylesheet and the redirects: that is how everything is withdrawn.

Withdrawing is the redirect, not the redeploy. Pages' edge answers a path the
live deployment lacks from a copy it cached up to `s-maxage=604800` (7 days)
earlier, through new deployments, deleted deployments, zone purges and any
`Cache-Control` in `_headers`; a `_redirects` rule is consulted first, and the
copy returns once the rule is gone, hence the week. A path still in the
snapshot is served fresh on the next deploy. Not covered: a file removed from a
board that stays published, a slug published again within the week (its old
files' paths), a board folder removed outright — each stays readable at its
path up to 7 days. Deleting the Pages project ends every copy at once.

No `pagesProject`: `boards: no Pages project configured — Console → Boards`,
exit 1; the skill then sets `public` back to `false` and hands out the
private link.

The button is `POST /api/boards/publish`: the steps above with the target read
from settings, answered as an SSE stream of `{log}` (wrangler's output as it
arrives), `{out}` (a result line), `{err}` (a `boards:` line) and a last
`{exit}`, pinged every 15 s while wrangler waits on an approval. One publish at
a time per Pier process — a second is `409 {error: "a publish is already
running"}` — and no project is `422`. A closed tab does not stop it. The card
streams the output, links each published URL, ends on `Published.` or `Publish
failed`, and redraws the board list. A shell's publish and the button's are not
serialized against each other; step 6 keeps that race harmless.

## Shipped stylesheet (`/b/_assets/pier.css`)

[`pier.css`](../../src/boards/pier.css) is served from Pier's package directory
and copied into every Pages snapshot at the same path, so one `<link>` works
on both; it styles semantic HTML with responsive widths, dark mode and optional helpers.
Sibling blocks share their responsive container width, which is also the reading
measure; `.prose` caps that column on an ultrawide canvas, and `.table-scroll`
keeps full-width native tables scrollable on phones.
Table regions and disclosures have visible keyboard focus; disclosures retain
44px touch targets. Body and KPI use system sans-serif, headings system serif.
The [skill](../../skills/pier-boards/SKILL.md) owns their usage and presentation
guidance: content determines layout, status has text labels, graphics serve
understanding. Custom CSS must preserve contrast and phone reflow; no linter.

## Routes (`src/boards/boards.ts`)

| Route | Behavior |
| ----- | -------- |
| `POST /api/boards/publish` | the Console's publish, an SSE stream (Publishing above; `publish.ts`) |
| `GET /b/_assets/pier.css` | the shipped stylesheet, password-free: a sandboxed board sends no cookie with its own subresources |
| `GET /boards/:slug/*` | the operator surface: 404 if the board is gone, else 302 to `/b/:slug/:view/*`, path and query kept |
| `GET /b/:slug/:view/*` | static from `<board>/site/`, **only** if `view` is a live signature for that slug; otherwise 302 back to `/boards/:slug/*`, path and query kept |

`/p/*` is gone: an old `/p/<slug>-<token>/` link meets the login form.

`view` is `<expiry in base36>-<HMAC(slug, expiry) truncated to 128 bits>`,
signed with a process-scoped key and valid for 8 hours. Its own path segment,
so the first hyphen is the cut and a hyphenated slug stays unambiguous; the
stamp must be the canonical base36 of the expiry it signs, or one signature
would be valid under several spellings. The signature covers the slug and its
directory's inode, so a board renamed away does not lend its prefix to the next
board on that slug. The key is rotated on every session revocation (`main.ts`),
because the page carries no cookie a sign-out could end. A dead prefix is not a 404: it
redirects to `/boards/:slug/*`, so a live session re-mints in one hop and a
stranger meets the login form.

A `/b/` URL is a bearer credential for one board until it expires: copied out
of the address bar it reads that board without the password, and setting
`public: false` does not revoke it.

Both static handlers: realpath containment against `<board>/site`, extension
whitelist extended with `html/css/js/svg/woff2/ico`, no directory listing,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (the URL is
the credential on both prefixes), `Cache-Control: no-store` (every board URL is
revocable, and a stored copy would outlive the revocation),
`Access-Control-Allow-Origin: *` (an opaque
origin needs CORS for its own fonts and modules), and a CSP of `sandbox
allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'self'; img-src 'self' data:; style-src 'self'
'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none';
frame-ancestors 'none'`.

No board gets `allow-same-origin` — the page is agent-written
script, and on the workbench origin it would read that origin's `localStorage`
and carry what it read out by top-level navigation, which no CSP directive
removes. The signed prefix exists to pay for that: an opaque-origin document
sends no `SameSite=Lax` cookie with its own sub-resources (verified in
Chromium), so a cookie-authorized board URL would 302 its own stylesheet and
images to `/login`.

`boards.ts` owns manifest reads, the scan and the routes; `publish.ts` the
Pages snapshot and its button route. `readManifest` is the single place a slug becomes a path and
is validated; every route and the publish reach the filesystem through it.
Depends on `node:*`, Hono types and the root `log.ts` / `paths.ts` leaves,
nothing in core; the routes are registered in `main.ts`, the publish reached
from `cli.ts` and `POST /api/boards/publish`.

## Agent surface (`skills/pier-boards/SKILL.md`)

The bundled skill covers creation, listing, publishing, deletion, presentation
and verification through file operations; `PiAgentFactory` loads it from `skills/`, with no new
tool or `boards.enabled` flag.

## Tests

- Filesystem units in a tmp `PIER_HOME`: slug validation, malformed manifest is
  skipped + logged (and treated as private), no manifest is ever written by a
  read, a renamed-away board 404s on every route and is listed while live.
- Route tests: `/p/*` serves nothing; `..`, absolute-path and symlink escapes
  rejected on the signed prefix; `board.json`, `README.md` and sources are 404
  even though they sit in the board dir.
- `publish.test.ts` with a fake `wrangler` on `PATH` recording its argv: the
  snapshot's contents, project creation, the deploy's flags, only older
  deployments deleted, the write-back on every state, nothing written on a
  failed deploy, written with exit 1 on a failed delete, wrangler missing,
  the socket's 422; the route's frames, a denied credential, the 409 while
  one runs, the 422.

## Acceptance

- An agent creates a board with plain file writes and lists it back when asked.
- A board created without an explicit public request is on no public URL;
  setting `public: true` and running `pier boards publish` puts it on Pages
  at the `url` its manifest then carries.
- A second, unrelated session edits the same board's content and description.
- Deleting the session that made it changes nothing about the board.
- New pages and layout/interaction changes pass the skill's phone/desktop,
  theme, keyboard/touch, asset and JavaScript-disabled checks; content-only
  edits check the affected content and links, with actual coverage or gaps reported.
