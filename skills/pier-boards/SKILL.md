---
name: pier-boards
description: Publish a Board — a folder of static HTML Pier serves at a stable URL. Read before building any page-shaped deliverable (report, digest, dashboard) or editing an existing board.
---

# Building a Pier board

A **board** is a directory in the boards folder `<pier>/AGENTS.md` names under
"This Pier instance" — use that path verbatim; `~/.pier` is only the default.
Pier serves `<board>/site/` and nothing else. Boards outlive sessions: any
session may read or rewrite any board, and closing this one changes nothing.

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

Those four fields are the whole manifest (publishing adds a fifth — below).

- `slug`: `[a-z0-9][a-z0-9-]{0,63}`, and it is the URL — short and stable. Do
  not add random characters of your own; publishing adds them (see below).
- `description` is the Console list entry: write it for someone who has
  forgotten this conversation.
- `sessions`: append your own id, never replace — other ids are provenance too.

## Publish, then hand over the link

`"public": true` serves the board **with no password**. Set it only if the user
asked for a public or shareable board *in this request*; otherwise leave it
`false` and say the board is private. Never publish personal data or anything
the user has not seen.

The published address is `/p/<slug>-<token>/`, not `/p/<slug>/`, so a public
board's URL cannot be guessed from its name. `token` is a fifth manifest field
you write next to `"public": true` — eight hex characters from
`openssl rand -hex 4`, never invented in your head, never reused between
boards. Leave it out and Pier mints one on the first request, but then the link
is only visible in the Console, so write it yourself and you can hand it over
in the same message.

Asked to make an existing board public? Set `"public": true` and a fresh
`token` in `board.json`, then reply with the `/p/<slug>-<token>/` link — that is
the whole answer. Already has a token? Keep it: the link may be out there. No
verification step, no narrating the edit, no restating what the page holds.

The message announcing the board carries **one bare URL** — paste the address
itself, never `[title](url)`: link labels get mangled or truncated on some chat
surfaces, and the title is already on the page. No filesystem paths either —
`…/boards/<slug>/board.json` means nothing to the reader.
`<pier>/AGENTS.md` gives you the address, so there is nothing to look up:

| The user asked for | Send |
| --- | --- |
| a board, nothing about sharing | `https://pier.example.com/boards/weekly-digest/` — behind the Pier password; Console → Boards makes it public |
| a **public** board | `https://pier.example.com/p/weekly-digest-3f9ac128/` — no password; the suffix is the manifest's `token`, copied verbatim |

Never both: the pair invites pasting the password-free URL of a board that was
never meant to leave the workspace, and `/p/<slug>-<token>/` 404s unless the manifest
says `"public": true`. No address configured? Give the path, say Console →
Settings turns it into a link, and never guess a host.

## Writing the page

A board is a **presentation**, not a text file: someone opens it to get an
answer fast. Link the shipped stylesheet and write plain semantic HTML — no
build, no npm, no framework:

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
<div class="hero">
  <h1>Weekly digest — infra</h1>
  <p class="lede">Throughput is up, but two migrations need a decision before Friday.</p>
  <p class="muted">18 Feb 2026 · covers 12 repos</p>
</div>

<div class="grid">
  <div class="card"><span class="kpi good">12</span> PRs merged <span class="muted">+3 vs last week</span></div>
  <div class="card"><span class="kpi warn">2</span> awaiting decision</div>
  <div class="card"><span class="kpi">98.9%</span> uptime <span class="muted">30 d</span></div>
</div>

<div class="callout warn">
  <strong>Needs you:</strong> the payments migration blocks two teams — approve or defer by Friday.
</div>

<h2>Payments is the only degraded service</h2>
<table>
  <thead><tr><th>Service</th><th>Status</th><th class="num">p95</th><th>Error budget</th></tr></thead>
  <tbody>
    <tr><td><strong>payments</strong></td><td><span class="tag bad">degraded</span></td><td class="num">910 ms</td>
        <td><span class="bar bad" style="--v:18%"></span></td></tr>
    <tr><td>api</td><td><span class="tag good">healthy</span></td><td class="num">142 ms</td>
        <td><span class="bar good" style="--v:82%"></span></td></tr>
  </tbody>
</table>

<details><summary>All 12 merged PRs</summary>
<table><thead><tr><th>PR</th><th>Author</th><th>Merged</th></tr></thead>
<tbody><tr><td>#412</td><td>ana</td><td>Mon</td></tr></tbody></table>
</details>

<footer>Written by Pier · data as of 18 Feb 09:00 · ask for an update to refresh</footer>
</body>
</html>
```

What makes it read as designed rather than generated:

- **The lede is the verdict, not the topic.** "Two migrations need a decision by
  Friday" answers; "This digest covers infra activity" restates the prompt. A
  reader who stops after the hero must still leave with the point.
- **Headings are findings.** "Payments is the only degraded service", not
  "Services". A heading that could top any report — Overview, Summary, Details —
  says nothing about this one.
- **Every number carries its unit and its baseline**: "142 ms p95, was 120",
  "12 of 40". A bare number is decoration; so is fake precision (98.8724% →
  98.9%).
- **End at the last useful block.** No closing summary, no filler section. The
  footer holds provenance: data as-of, source, how to refresh.

## What `pier.css` gives you

Headings, paragraphs, lists, tables, `pre`/`code`, `blockquote`, `details` and
`footer` are styled with **no classes at all**, dark mode included. The page
sizes itself: a wide desktop canvas (62rem, 76rem on a very large screen) that
reflows to one column on a phone, prose held to a readable measure while tables,
`.grid`, `.split` and `.hero` use the full width — don't add a `max-width` of
your own. Zebra striping, tables that scroll inside themselves, and `<details>`
that print open are free. On top of that:

| Class | Use it for |
| --- | --- |
| `.lede` | the one-sentence answer under the title |
| `.hero` | the opening block: title + lede + date/scope, on a tinted panel |
| `.grid` + `.card` | a KPI row (auto-fits to one column on a phone) |
| `.kpi` | the headline number inside a card |
| `.card` + `.good/.warn/.bad/.info` | a status card: accent edge and tinted fill |
| `.callout` (`.good` `.warn` `.bad`) | the takeaway or the ask |
| `.tag` (`.good` `.warn` `.bad` `.info`) | status pills in tables and lists |
| `.good` `.warn` `.bad` | colour on a number or a word |
| `.num` | right-aligned, tabular numeric table cells |
| `.bar` (`.good` `.warn` `.bad`) | share-of-total inside a table: `style="--v:62%"` |
| `.split` | two columns that stack on a phone: before/after, text + aside |
| `.muted` | secondary text: dates, deltas, units, scope |

Need something it lacks? A `<style>` block or your own CSS file inside `site/`
is normal, and so is a custom colour or a hand-written layout when the content
calls for one.

## Pick the form from the content

| What you have | How to present it |
| --- | --- |
| The single most important fact | `.hero` lede, or one `.kpi` on its own |
| 2–4 headline metrics | `.grid` of `.card`s, each with `.kpi` + a `.muted` delta |
| Something the reader must act on | `.callout warn` near the top, naming the deadline |
| Items with a state | table with `.tag` pills, worst rows first |
| Ranked or compared numbers | table, `.num` columns, `.bar` for share of total |
| Progress toward a goal | `.bar` per row, or `.kpi` + "of 40 done" in `.muted` |
| Two alternatives | `.split` with a `.card` each, verdict in the lede above |
| A sequence of events | ordered list, date in `.muted` at the start of each item |
| A trend over time | first/last + delta in words; inline SVG only if the shape *is* the news |
| 200 rows | aggregate, show the 5–10 that matter, rest in `<details>` with the count in its summary |
| 1–2 data points | a sentence or a `.callout` — a one-row table is a table costume |
| Long raw output, logs, code | `<details>` at the bottom, or `<pre><code>` trimmed to the lines that matter |
| Nothing to report | say so in the lede ("all 14 checks green") and stop — short is finished, not thin |

Vary the forms: never two blocks of the same kind in a row, and prefer number →
ask → proof → fold over six paragraphs. A status or decision board earns one
screenful before the first `<details>`; only a handover or postmortem earns a
long scroll. Colour is part of the message — green healthy/done, amber
attention/pending, red broken/blocked, `.info` neutral emphasis — on the numbers
and status cells that carry the point, never on ordinary prose; that contrast is
what makes it read as signal.

## Rules

- **No secrets, ever.** Tokens, API keys, credentials, internal hostnames and
  private paths never go into a board — not in the page, not in a `<details>`
  fold, not in a code sample. A private board is one Console toggle from
  public, so write every page as if it already were.
- **Static and self-contained.** Everything the page needs lives under `site/`
  with relative paths. No CDN, no external fonts, no analytics, no `fetch()` —
  a published board is served under a CSP that blocks all of it, so an external
  reference is a broken page, not a slow one.
- **Content, not an app.** Interaction is `<details>` and anchors; the page
  stays readable with JavaScript off.
- **Show, don't narrate.** A sentence describing numbers should have been a KPI
  row or a table. Prose is for judgement — what it means, what to do.
- **Structure before graphics.** A chart is inline SVG (no library) and only
  when the *shape* of the data is the message. A three-row table beats any
  picture of three numbers; no chart beats a decorative one.
- **Only real data.** Every figure traces to something you saw this session, and
  a gap is shown as a gap ("no data since Tue", "~3 weeks", "n=3") — never
  smoothed into a clean number.
- **Rewrite in place.** Updating a board means editing its files, not creating
  `weekly-digest-v2`. The URL is the point.
- Top-down — what this is → the answer → detail → raw data in `<details>` —
  prose in the user's language, short headings, no emoji chrome.

## If a board needs a build

Pier ships no toolchain and the default is no build. If one is genuinely needed
(a bundled charting library, a component layout), you own it: keep sources
outside `site/` (e.g. `<board>/src/`), emit into `site/`, and write a
`<board>/README.md` a future session can follow cold — install command, build
command, output path, where the data came from. Never leave `site/`
inconsistent with its sources; on an existing board look for that README first
and rebuild, because hand-patching `site/` is lost on the next build.
