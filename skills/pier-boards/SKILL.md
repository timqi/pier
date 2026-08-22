---
name: pier-boards
description: Publish a Board — a folder of static HTML Pier serves at a stable URL — to present a report, digest, dashboard or handover note to the user. Read before building any page-shaped deliverable, or before editing an existing board.
---

# Building a Pier board

A **board** is a directory under `~/.pier/boards/<slug>/` (or
`$PIER_HOME/boards/<slug>/`). Pier serves `<board>/site/` and nothing else.
Boards outlive sessions: any session may read or rewrite any board, and closing
this session changes nothing.

## Create one

```
~/.pier/boards/weekly-digest/
  board.json
  site/index.html
```

`board.json` — exactly these fields:

```json
{
  "title": "Weekly digest — infra",
  "description": "What changed in infra this week and what needs a decision.",
  "sessions": ["<your session id>"],
  "public": false
}
```

- `slug`: `[a-z0-9][a-z0-9-]{0,63}`, and it is the URL, so keep it short and
  stable.
- `description` is what a human sees in the Console list — write it for someone
  who has forgotten this conversation.
- `sessions`: add your own session id (append, never replace — other sessions'
  ids are provenance too).
- Tell the user the board's path and its URL, `/boards/<slug>/`, when you are
  done.

## Publishing

`"public": true` makes the board readable at `/p/<slug>/` **without any
authentication**. Set it only when the user asked for a public or shareable
board *in this request*. Otherwise leave it `false` and say the board is
private; the user can flip it in Console → Boards. Never publish a board that
contains credentials, internal paths, personal data or anything the user has
not seen.

## Writing the page

A board is a **presentation**, not a text file: someone opens it to get an
answer fast. Lead with the verdict, prove it with structure — a headline
number, a coloured status, a scannable table — and fold raw detail into
`<details>`. Link the shipped stylesheet and write plain semantic HTML — no
build, no npm, no framework:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly digest — infra</title>
<link rel="stylesheet" href="/boards/_assets/pier.css">
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

The habits that make it read as designed, not generated:

- **The lede is the verdict, not the topic.** "Two migrations need a decision
  by Friday" answers; "This digest covers infra activity" restates the prompt.
  A reader who stops after the hero must still leave with the point.
- **Headings are findings.** "Payments is the only degraded service", not
  "Services". If a heading could top any report — Overview, Summary, Details,
  Conclusion — it says nothing about this one.
- **Every number carries its unit and its baseline**: "142 ms p95, was 120",
  "12 of 40". A bare number is decoration; so is fake precision — round to
  what changes the reader's decision (98.8724% → 98.9%).
- **End at the last useful block.** No closing summary. The footer holds
  provenance: data as-of, source, how to refresh.

## What `pier.css` gives you

It styles headings, paragraphs, lists, tables, `pre`/`code`, `blockquote`,
`details` and `footer` with **no classes at all**, is mobile-first and has a
dark mode. On top of that:

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

For free, with no classes: zebra-striped tables that scroll inside themselves
on a phone, `<details>` that print open, automatic dark mode.

Need something it lacks? Add a `<style>` block or your own CSS file inside
`site/` — that is normal, and so is a custom colour, a gradient, or a
hand-written layout when the content calls for one.

## Patterns that carry a message

Pick the form from the content, and vary the forms so the page has rhythm —
never two blocks of the same kind in a row. Six identical paragraphs (or six
identical tables) communicate worse than number → ask → proof → fold.

| What you have | How to present it |
| --- | --- |
| The single most important fact | `.hero` lede, or one `.kpi` on its own |
| 2–4 headline metrics | `.grid` of `.card`s, each with `.kpi` + a `.muted` delta |
| Something the reader must act on | `.callout warn` near the top, naming the deadline |
| Items with a state | table with `.tag` status pills, worst rows first |
| Ranked or compared numbers | table, `.num` columns, `.bar` for share of total |
| Two alternatives | `.split` with a `.card` each, verdict in the lede above |
| Progress toward a goal | `.bar` per row, or `.kpi` + "of 40 done" in `.muted` |
| A sequence of events | ordered list, date in `.muted` at the start of each item |
| A recommendation | `.callout` with the recommendation as its first sentence |
| A trend over time | first/last + delta in words; inline SVG only if the shape *is* the news |
| 200 rows | aggregate, show the 5–10 that matter, rest in `<details>` with the count in its summary |
| 1–2 data points | a sentence or a `.callout` — a one-row table is a table costume |
| Nothing to report | say so in the lede ("all 14 checks green") and stop — short is finished, not thin |
| An estimate, a gap | mark it: "~3 weeks", "n=3", "no data since Tue" — never smooth over or invent |
| Long raw output, logs, full lists | `<details>` at the bottom, one line summarising it |
| Code or config | `<pre><code>`, trimmed to the lines that matter |

Scale to the job: a status or decision board earns one phone-screen before the
first `<details>`; only a narrative (handover, postmortem) earns a long
scroll, and then the hero carries the recap. Inside a table, order rows by
what the reader must see first and `<strong>` the one cell that is the point.

Colour is part of the message: green for healthy/done/up, amber for attention
or pending, red for broken/blocked/down, `.info` (indigo, tags and cards) for
neutral emphasis. Put it on the numbers and status cells that carry the point,
and leave ordinary prose in the default colour — that contrast is what makes
the coloured parts read as signal.

## Rules

- **Static and self-contained.** Everything the page needs lives under `site/`
  with relative paths. No CDN links, no external fonts, no analytics, no
  `fetch()` to anywhere — a published board is served with a CSP that blocks all
  of it, so an external reference is a broken page, not a slow one.
- **Content, not an app.** Interaction is `<details>` and anchors. Keep the page
  readable with JavaScript off.
- **Show, don't narrate.** If a sentence describes numbers, make it a KPI row or
  a table instead. Prose is for judgement — what it means, what to do — not for
  reciting data the page can display.
- **Structure before graphics.** A chart is inline SVG (no library) and only
  when the *shape* of the data is the message — a trend, a distribution, a
  breakdown. `.bar` covers most "how much of the total" cases already, and a
  three-row table beats any picture of three numbers. No chart is better than a
  decorative one.
- **Presentation, not padding.** Every block earns its place: no filler
  sections, no restating the title, no "in conclusion". If it does not change
  what the reader thinks or does, it goes in `<details>` or goes away.
- **Only real data.** Every figure traces to something you saw this session; a
  gap is shown as a gap ("no data"), never estimated into a clean number.
- **Mobile-first.** No fixed widths, no horizontal scroll, tables wrapped or
  scrolled inside themselves.
- One page, top-down: what this is → the answer → supporting detail → raw data
  in `<details>`. Prose in the user's language, short headings, no emoji chrome.
- **Rewrite in place.** Updating a board means editing its files, not creating
  `weekly-digest-v2`. The URL is the point.

## If a board really needs a build

Pier ships no toolchain — the default is no build at all. If a board genuinely
needs one (a bundled charting library, a component-based layout), you own it:

- keep sources outside `site/` (e.g. `<board>/src/`), emit into `site/`;
- write `<board>/README.md` that a future session can follow cold: install
  command, build command, output path, where the data came from;
- never leave `site/` inconsistent with its sources.

Before editing an existing board, look for `README.md` and a sources
directory — if they exist, change the sources and rebuild. Hand-patching
`site/` is lost on the next build.
