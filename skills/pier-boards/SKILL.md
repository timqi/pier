---
name: pier-boards
description: Publish a Board — a folder of static HTML Pier serves at a stable URL. Read before building any page-shaped deliverable (report, digest, dashboard) or editing an existing board.
---

# Building a Pier board

A **board** lives in the exact boards folder named under "This Pier instance"
in `<pier>/AGENTS.md`; do not assume `~/.pier`. Only `<board>/site/` is served.
Boards survive sessions; any session may read or update them.

## Create one

```
<boards folder>/weekly-digest/
  board.json
  site/index.html
```

```json
{
  "title": "Weekly digest — infra",
  "description": "What changed in infra this week and what needs a decision.",
  "sessions": ["<your session id>"],
  "public": false
}
```

- `slug`: `[a-z0-9][a-z0-9-]{0,63}`; keep it short and stable, without random suffixes.
- `description`: Console list text, understandable without this conversation.
- `sessions`: append your id; preserve others as provenance.

## Publish, then hand over the link

`"public": true` serves the board **with no password**. Set it only if the user
asked for a public or shareable board *in this request*; otherwise leave it
`false` and say the board is private. Never publish personal data or anything
the user has not seen.

For publishing, preserve the manifest's `token` or add eight hex characters
from `openssl rand -hex 4`; never invent or reuse another board's token.

Use the instance address from `<pier>/AGENTS.md` plus:

| Visibility | Path |
| --- | --- |
| Private (default) | `/boards/<slug>/` — password required; Console → Boards can publish |
| Public | `/p/<slug>-<token>/` — copy the token verbatim; 404 unless `public: true` |

Return **one bare URL**, never both, Markdown link labels or filesystem paths.
If no address is configured, give the path and point to Console → Settings;
never guess a host. For a publish-only request, set `public: true` and a token
if missing, then return only the public URL; no page verification or narration.

## Writing the page

Let the question and evidence determine layout; no sections are required.
Use semantic HTML without a framework. Adapt this shell's language and content:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly digest — infra</title>
<link rel="stylesheet" href="/p/_assets/pier.css">
</head>
<body>
<h1>Weekly digest — infra</h1>
<p class="lede">The main finding, grounded in the available evidence.</p>
<footer>Data as of … · sources … · how to refresh …</footer>
</body>
</html>
```

Lead with the verdict; headings state findings ("Payments alone is degraded").
Numbers carry units and baselines ("142 ms p95, was 120", "12 of 40"), without
false precision. End without filler or a closing summary; put the data
timestamp, sources and refresh instructions in the footer.

## What `pier.css` gives you

Classless defaults include readable prose, responsive widths, dark mode,
scrolling zebra tables and print styles. Override widths only as needed.

| Class | Use it for |
| --- | --- |
| `.lede` / `.hero` | opening answer / tinted opening panel |
| `.grid` + `.card` + `.kpi` | responsive cards with headline numbers |
| `.callout` / `.tag` | takeaway or ask / status pill |
| `.num` | right-aligned tabular numbers |
| `.bar` | proportion: `style="--v:62%"` |
| `.split` | two columns, stacking on phones |
| `.muted` | dates, deltas, units, scope |

Status modifiers: `.good` healthy/done, `.warn` attention/pending, `.bad`
broken/blocked; express status in words too. These colour text, cards,
callouts, tags and bars; cards and tags also accept `.info` for neutral emphasis.
All helpers are optional. Custom `<style>` or CSS under `site/` may change
layout and palette while preserving contrast and phone reflow.

## Pick the form from the content

| Content | Possible form |
| --- | --- |
| One finding or 1–2 values | sentence; if nothing changed, say so and stop |
| Headline metrics | KPI cards with deltas; progress includes the total |
| Required action | prominent ask with deadline |
| States, rankings or shared comparison criteria | table; worst states first |
| Alternatives needing separate explanations | parallel sections; recommendation first |
| Events / trends | dated list / endpoints and delta; chart when shape explains the finding |
| Large datasets or raw output | aggregate, show relevant rows, fold the rest with a count; trim code/logs |

Repeat forms for comparable items; vary them when information changes. Put
findings and actions first, then evidence; fold only supplementary detail.

## Rules

- **No secrets:** no tokens, API keys, credentials, internal hostnames or
  private paths in page content, including folds and code samples; private
  boards can become public with one Console toggle.
- **Self-contained:** assets live under `site/` with relative paths, except
  the shipped stylesheet; no CDN, external fonts, analytics or `fetch()`
  (blocked by the public CSP).
- **Interaction:** prefer `<details>` and anchors; local JS may sort, filter or
  inspect embedded data, without network calls or server runtime. With JS off,
  keep the answer and evidence readable; hide or disable unavailable controls.
- **Charts:** use when data shape explains the finding; prefer inline SVG,
  a small bundled library only for needed interaction, with text/table fallback.
- **Real data:** every figure traces to evidence seen this session; expose
  gaps and uncertainty ("no data since Tue", "~3 weeks", "n=3").
- **Update in place:** edit the existing board; preserve its URL.
- Write in the user's language, with short headings and no emoji chrome.

## Check the page

For new pages or layout/interaction changes, run the checks below; for content
edits, check the affected content and links. Report actual coverage or gaps.

- Phone/desktop, light/dark: readable contrast, no page overflow, tables scroll internally.
- Keyboard/touch: working links and controls, visible focus, usable targets, text status labels.
- Assets load without console errors; answer and evidence remain readable with JS off.

## If a board needs a build

Pier ships no toolchain. If a build is needed, keep sources outside `site/`,
emit into `site/`, and document install/build commands, output path and data
sources in `<board>/README.md`. Before editing an existing board, check for
that README; update sources and rebuild so `site/` stays consistent.
