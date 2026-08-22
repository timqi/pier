# Design review (post-Slack)

`AGENTS.md` sets a tripwire at "repo ~5k → design review". The repo is at 10.9k
non-test lines, so this is that written diagnosis. Measured, not estimated:
non-blank, non-comment lines.

| Area | Code lines | What it is |
| --- | --: | --- |
| `web/` | 4250 | workbench UI + HTTP server |
| `channels/` | 3087 | two adapters + the shared IM layer |
| `tasks/` | 2398 | definitions, runs, groups, callbacks, tool |
| `agent/` | 652 | the Pi seam |
| `core/` | 465 | routing, queue, reply, hub, identity |
| `main.ts` | 88 | wiring |
| **total** | **10940** | plus 4645 lines of tests |

## The budgets are wrong, not (mostly) the code

Three tripwires, and two of them have never held:

- **`repo ~5k`** — passed long before Slack. Pier is four surfaces (web, two IM
  platforms, tasks) over one agent seam; 5k was a bootstrap-era number for
  roughly one of them. It has stopped being a signal, because it fires
  unconditionally and therefore says nothing.
- **`channel adapter ≤ 200`** — Telegram is 350, Slack 475. Both are already
  split four ways (adapter / transport / render / panel), so the excess is not
  a missing seam; it is the inbound normalization and gate-logging that each
  platform's own event shape forces. See `04-im-channels.md` for the per-file
  diagnosis.
- **`core module ≤ 300`** — this one holds, everywhere, and it is the one that
  has actually shaped the design. Core is 465 lines *in total* across six files.

**Done:** `AGENTS.md` now carries per-area budgets instead of a repo-wide
number — `core/` ≤ 500 (the one that shaped the design, kept tight), any module
≤ 300, a channel *adapter* file ≤ 400, `web/` ≤ 4.5k, `tasks/` ≤ 2.5k,
`channels/` ≤ 3.5k. Most sit just above today's size on purpose, so the next
feature in each area has to be visibly worth it. A budget that is always
exceeded is not a tripwire, it is a comment.

### The first thing the new budgets caught

`slack.ts` is **444 against its 400**, and the diagnosis the tripwire asks for:

- The genuinely shared part is already out. `SlackDirectory` (channel kind/name
  + user names, cached per process) came out *because* of this budget, and it
  paid for itself twice: the agent tool was re-resolving every speaker's name on
  every `read_thread`, and now shares the adapter's cache.
- What remains is irreducibly Slack: three envelope types where Telegram has
  two, `event_id` dedup against at-least-once delivery, and the outbound
  markdown-block policy with its mrkdwn fallback.
- The next real split is **inbound vs outbound** — `send`/`notify`/`postBody`
  are ~90 lines of outbound concern in a file otherwise about normalizing
  inbound. Worth doing when Telegram can be split the same way, so the two
  adapters stay symmetric; not worth doing to one of them alone.

Left over-budget on purpose rather than raising the number to fit: the point of
400 is that a third adapter should feel it too.

## Where the weight actually is

**`web/` is 39% of the code and has no tests worth the name.** That is the real
finding. `ui/channels.ts` (613), `ui/main.ts` (576), `ui/tasks.ts` (565) and
`ui/chat.ts` (548) are the four largest files in the repo, and only
`web/server.ts` is covered. Every rendering bug found in this cycle — "Show
more", the unbalanced code fence, the empty silent bubble — was found by a human
looking at a screen, because there is no oracle for layout below that.

This is the highest-value place to spend next, and the cheapest useful step is
not a test framework: it is making the surfaces smaller.

## Done in this review

- **Walkthrough copy is content, not DOM calls.** Five help bubbles were built
  from `h()`/`append()` at ~5 lines a sentence. `marked` and DOMPurify were
  already bundled for the transcript, so `prose()` in `dom.ts` renders inline
  markdown and the steps are strings. `channels.ts` 717 → 613, bundle 0.9 kB
  smaller, no new dependency.
- **Five duplicated invariants extracted** from the two adapters
  (`gatekeeper.ts`, `chains.ts`, `chunk.ts`, `originLabel` → `core/reply.ts`).
  Barely a line saved; the point is that each rule is now stated once. Full
  reasoning in `04-im-channels.md`.

## Recommended, not done

- ~~A shared Console form vocabulary.~~ **Done** — Lark made it the third
  surface, which is what the rule was waiting for. `ui/form.ts` (148 lines) now
  owns card / field / toggle / inputs / select / textarea / badge / empty /
  helpBadge, and absorbed both divergent sets rather than sitting beside them.
  `channels.ts` 613 → 508, `tasks.ts` 565 → 539.
  - One `field` chrome for the whole Console. Tasks rendered a plain `<label>`
    and Channels a micro-caps header with hint and help slots; the second is
    the richer idiom, so Tasks moved to it. Its 18 fields therefore *look*
    different now — worth an eyeball, since `web/` has no layout oracle.
  - `field`'s third and fourth positional arguments became one options object.
    Four positionals where two are optional is a call site nobody can read.
  - **One button.** `.btn`/`.btn-primary` are the only custom classes
    `style.css` declares, which makes them the Console's button — so
    `button(label, primary)` is what a button is, and raw `btn(label, cls)` is
    reserved for the clickable things that are not button-shaped (tabs, menu
    rows, inline links, the help badge). Two bespoke indigo buttons added with
    the Slack walkthrough are gone, and one call site that hand-wrote `"btn"`
    as a raw class is now saying what it means.
  - `CONTROL` is exported, so the model dropdown's trigger wears the same skin
    as the inputs beside it instead of a copy that had already drifted.
- **`ui/main.ts` (576) is a shell doing five jobs**: session CRUD, header/meta
  rendering, event fan-out, view switching, hash routing. It has been split
  once already. Routing is the separable piece and the one with real logic
  (`parseHash`/`applyRoute`/`setHash`); the rest is genuinely shell.

## Deliberately not done

- **The two in-chat panels stay duplicated.** Same shape, different rendering
  primitives. Extracting from two data points is what the rule exists to
  prevent; Lark earns it. (`04-im-channels.md`)
- **The Slack mrkdwn fallback stays.** ~88 lines that run only when Slack
  refuses a `markdown` block. It costs no tokens and no happy-path CPU — it is
  never called unless a send is rejected — so its only cost is maintenance, and
  it buys "an old workspace degrades instead of showing literal `**bold**`
  forever". avibe carries the same fallback, which is production evidence that
  the rejection happens.

## Open, needs a decision outside this review

- **Nothing authenticates.** Unchanged from `architecture.md`'s open question,
  but the stakes rose twice this cycle: the Console now stores two Slack tokens,
  and `agentTool` lets any agent session read and post to a workspace. Still
  one answer for every surface, still not designed.
- **`ChatKind`/`topicMode` did not generalize.** Slack reports every channel as
  `"group"` and its thread mode is a constant, not a switch. Two platforms is
  enough to see the shape; Lark should settle it (probably an adapter
  capability, not a stored flag). Recorded in `architecture.md`.
