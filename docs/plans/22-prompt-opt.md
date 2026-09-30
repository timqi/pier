# Prompt opt — one owner per rule, one rule per line

Status: final (lead branch `prompt-opt`).

Source: the head's prompt survey (run `63f4gs0mtqfpr7rk`), and a second
opinion on the workflow the prompts encode (`gpt-6-astra`, run
`jsh0sjmaz29ecv12`, its report `22-prompt-opt.review.md` beside this file,
evidence from 21 transcripts). What every role's system prompt costs as Pi
assembles it, where the same rule is stated twice, where one line carries five
rules — and where the workflow itself loses information between stages, which
costs more turns than any prompt line. D1–D9 are the prompt; D10–D12 the
workflow. Design only; the worker branches are named at the end.

## What a role loads

Pi's prompt for a Pier session is four sections: `preamble` (Pier's baseline,
`agent/pi.ts` `pierBaseline(role)`, then the operator's `SYSTEM.md`),
`project_context` (the cwd's `AGENTS.md` files, `<pier>/AGENTS.md` =
`surfacePrompt(role)`, then the role file `<pier>/dispatcher.md | lead.md |
worker.md`), `skills` (name, description, path per skill) and `cwd`. With a
custom preamble Pi adds none of its own tools/rules/docs text.

## Measured

Tokens are `o200k_base` counts of the system message recorded in each role's
most recent transcript (`~/.pier/pi/sessions`, 2026-09-29/30); Pier's Console
shows chars/4, ~10% higher. Numbers in parentheses are the pieces.

| Role | System prompt | preamble | `<pier>/AGENTS.md` | role file | skills | repo `AGENTS.md` | first message |
| --- | --- | --- | --- | --- | --- | --- | --- |
| head (dispatcher) | **4 462** | 901 (baseline 638 + SYSTEM.md 263) | 759 | 1 760 | 980 | — | + seed 2 676 at open |
| worker, non-repo cwd | **2 217** | 555 (292 + 263) | 310 | 418 | 875 | — | 142 |
| reviewer (a worker in the pier repo) | **4 878** | 555 | 310 | 418 | 875 | 2 633 | 538 (`reviewPrompt`) |
| lead, design (pier repo) | **5 532** | 901 | 759 | 168 | 980 | 2 633 | 133 |
| lead, build (pier repo) | **6 314** | 901 | 728 | 630 | 949 | 3 015 | 259 |
| role-less (cron, user session) | **2 689** | 901 | 759 | — | 980 | — | + `RUN_RESULT` 286 per run |

Pieces of the pieces:

| Piece | Tokens | Lines | Of |
| --- | --- | --- | --- |
| baseline, chat Communication | 386 | 9 bullets | preamble |
| baseline, Working style | 217 | 6 bullets | preamble |
| baseline, worker Communication (`VERBATIM_RULES`) | 40 | 2 | preamble |
| surface: buttons + attachments | 215 | 2 bullets | `<pier>/AGENTS.md` |
| surface: silent | 61 | 1 | both |
| surface: header paragraph (chat) | 254 | one paragraph, 7 facts | `<pier>/AGENTS.md` |
| surface: header (worker) | 90 | | worker's |
| surface: quote | 70 | | chat |
| surface: instance (boards, address, no `apply_patch`) | 135 | | both |
| `DISPATCHER` §Dispatch | 972 | 9 bullets, 3 of them 157–217 tokens | dispatcher.md |
| `DISPATCHER` §Models (`MODEL_TABLE`) | 146 | | dispatcher.md, lead.md (build) |
| `DISPATCHER` §Memory | 318 | 7 bullets | |
| `DISPATCHER` §Open items | 270 | 4 bullets, one 119 | |
| `RUN_RESULT` | 286 | one sentence-chain | worker.md; every role-less run message |
| `WORKER` head | 107 | | |
| `lead("build")` §Build | 427 | 7 bullets | |
| `lead("design")` §Design | 130 | 3 bullets | |
| skills section: Pi's header | 72 | | every role |
| skills section: Pier's 7 entries | 634 | 79–104 each | every role (worker: 6) |
| skills section: the operator's 2 entries | 258 | | every role |
| `skills/pier-tasks/SKILL.md` (read on demand) | 2 629 | 147 | head, lead |
| `skills/pier-help/SKILL.md` (read on demand) | 2 588 | 190 | |
| pier's own `AGENTS.md` | 2 633 | 168 | every session in the pier repo |

Reads on demand, 25 recent head sessions (608 inputs): `pier-tasks` 9 times,
`pier-slack` 4, `pier-web` 3, `pier-boards` 2, `pier-help` 1, `pier-vault` 1 —
each ~0.3–2.6K; not the cost.

What the numbers say:

- The system prompt is cached (the head requests the 1h TTL, 10 §Cache), so
  its price is paid at open and rotation, not per turn. The cost that matters
  is rules per line: a 217-token bullet with five semicolon-joined rules is
  followed less reliably than five lines, whatever the count.
- For any session in the pier repo the repo's `AGENTS.md` is the largest block
  (43–48% of a lead's prompt), larger than every Pier contract together.
- Skill *descriptions* cost as much as a role file (634 vs 418 for a worker)
  and repeat the same "Read before …" clause seven times.

## Findings

### F1. One rule, two to four owners (loaded together)

| Rule | Stated in | Copies one session sees |
| --- | --- | --- |
| reply language | baseline Communication #4 "Reply in the language of the request"; surface "Reply in the language of the most recent `lang=` …"; worker: `VERBATIM_RULES` + `HEADER_WORKER` | 2 |
| destructive step stops, `Approved:` line resumes | baseline Working style #5 (75 tok); `RUN_RESULT` (restated, ~70 tok); `reviewPrompt` ("an `Approved:` line … authorizes nothing") | 2–3 (worker) |
| a build run never merges / removes a worktree | `WORKER` head; `lead("build")` #6; `DISPATCHER` #9 (from the user's side); `skills/pier-tasks` finish paragraph | 1 per role + the skill |
| callbacks are the only delivery, end the turn, never poll | `DISPATCHER` #7; `pier-tasks` (bold); `lead("build")` #7 "never for waiting" | 2 (head, lead) |
| `--model` required, tiers, thinking follows the pin | `MODEL_TABLE` header + footer; `pier-tasks` §Model choice paragraph 1 | 2 |
| the result's two parts and the status line | `RUN_RESULT`; `pier-tasks` two paragraphs "A child's result follows the worker contract…" + "A result's status line is…" (~200 tok); `lead("build")` #3 points a lead at the 2.6K skill to learn the 286-token form | 2 |
| `pier task runs` is for orientation, not waiting | `lead("build")` #7; `pier-tasks` §Cancel · recover | 2 |
| the seed's content | `DISPATCHER` §Memory #7 lists it; the seed itself arrives at open | 2 |

### F2. Dense lines

`DISPATCHER` §Dispatch: #7 (silence, 👀, callbacks silent, decision replies in
your words, trust the child's state, doubtful → child) 180 tokens / 147 words,
six rules; #8 (code worker flags, `Goal:` callback, stage, sequence, decision
loop) 157 / 101; #9 (merge is the user's, buttons, `finish` flags,
content-merged branch rule, never resume to merge, ask-first scope, restart)
217 / 166, seven rules. §Open items #1 119 / 77. `RUN_RESULT` is one 286-token
sentence-chain. The surface header is one 254-token paragraph carrying seven
facts. `lead("build")` #3 98 / 77.

### F3. Contradictions a cheap model meets

- A reviewer and a finish run are workers: `WORKER` says "commit before you
  end your turn — an uncommitted change is not handed off" and "never merges
  into the target branch"; the review message says "do not edit, commit or
  merge", the finish message approves a merge. The `Approved:` line resolves
  the second; the first is only softened by "A build run".
- `WORKER` teaches the worker `Verdict:` and `Needs your decision` in one
  breath; a review needs only the first, a build only the second.

### F4. Tests pin prose, not contract

`agent/roles.test.ts` has 81 `toContain` assertions on sentences ("goes to a
child to check, never re-run by you"). Every rewording rewrites the test, so
the prompt is frozen by its test rather than by what code parses. What code
parses is small: `core/reply.ts` (`<silent>`, `<open>`, `<done>`, `<topic>`,
`<note>`, `---` buttons, `file://`), `tasks/goals.ts` `STATUS` (`Verdict: …`,
`Needs your decision — …`), `Design final:`, `Goal:`, `Approved:`, and the
flags the head must emit (`--role lead`, `--design`, `--worktree`, `--rounds`,
`--review-model`, `pier task finish --run … --remove-worktree`).

### F5. Repo `AGENTS.md`

Pier's own `AGENTS.md` (2 633 tok) is loaded by every lead, worker and reviewer
in the repo; §Docs, §Comments and the Budgets table's "What the size is"
column serve the committer's judgement, which those roles are. Not a role
prompt; named here because it is the largest thing in the prompt, and left to
its own decision (§Not in this feature).

## Decisions

### D1. One owner per rule

The owner is the lowest layer every reader of the rule loads; the other
copies go, or shrink to a pointer of one clause.

| Rule | Owner | Goes / shrinks |
| --- | --- | --- |
| reply language | surface prompt (`lang=` rule, with "the request's language when no header" — a fresh run's first message carries none, `tasks/agent.ts` derives it from history) | baseline #4 keeps "paths, identifiers and quoted output stay verbatim" only; `HEADER_WORKER` keeps the `lang=` rule, `VERBATIM_RULES` drops it |
| destructive step, `Approved:` | baseline Working style #5 | `RUN_RESULT` keeps only "stops you: state it as your result, end on the status line" and names Working style for what stops; the `Approved:` sentence goes (Working style has it) |
| build runs never merge / remove | `DISPATCHER` (the user's decision) | `WORKER` and `lead("build")` #6 each one clause: "the merge and every worktree's removal are the user's, run by your supervisor; you never merge into the target, run `wt merge`/`wt remove`, or are resumed to" |
| callbacks only, never poll | `DISPATCHER` #7 → its own line | `lead("build")` #7 goes (the skill owns `pier task runs`) |
| model rules | `MODEL_TABLE` | `pier-tasks` §Model choice paragraph 1 → one line pointing at the table; keeps `--model ?`, substring, `--review-model` |
| result form, reader side | `RUN_RESULT` (writer); `pier-tasks` one paragraph (reader) | the skill's two paragraphs → one: the last line is `Goal:` / `Needs your decision —` / `Verdict:`, answer with `--run <id> --prompt`, `Approved: <step>` for a step the user approved; `lead("build")` #3 carries the two-part form in one sentence instead of pointing at the skill |
| the seed | the seed | `DISPATCHER` §Memory #7 goes |

### D2. `DISPATCHER` rewritten one rule per line

Same contract, sub-headed, no bullet over ~45 words:

- **Who** (#1–#3): you vs a child; worker vs lead; `--design` only for a
  design the user finalizes.
- **Launch** (#4, #8's flags, #6): `--name`; a code worker's flags and
  defaults; a follow-up is `--run`/`--session`, the user's words verbatim.
- **After dispatch** (#7 split): write the `<open>` marker and end the turn;
  the dispatch is silent (`<silent>dispatched</silent>`), as is a callback that
  only moves the stage; a decision or a done is your own words (the callback
  is web-only); the child's verified state is trusted; a result that reports a
  missing directory or an unfinished verification goes to a child.
- **Code changes** (#8's rest, #9 split): build → review → wait → finish;
  "up to 3 reviews, stopped at the first clean verdict" replaces "3 reviews"
  (the cap is what code does, `tasks/goals.ts`); a `needs your decision` /
  `still findings` goal takes the answer back through `--run <root> --prompt
  --rounds <n>`, and the `<open>` marker moves to the root the `Goal:` line
  names (the review's own says which; `finish` refuses an older one); a clean
  review or a lead's done milestone is the merge question, three buttons in
  the reply's language — unless the user already authorized that action for
  this item, in which case the authorization is consumed, never inferred from
  a verdict, and merge, removal, restart and deploy are separate scopes; on
  yes `pier task finish --run <root|lead run>`, `--remove-worktree` only when
  said; the content-merged branch rule goes (D8); ask first beyond the merge
  only for a seam or a design; the restart is theirs.
- **Who, refined** (#1): the head may read one fact to answer or to dispatch
  — a known file, one read-only query, one status check; an investigation
  that grows past that (edits, test suites, installs, a browser, iterative
  debugging) is a child's with the evidence so far. `pier-tasks`' "a quick
  command belongs in your own shell" is subordinate to the role.
- **Recurring output** (new, one line): a scheduled report whose topics,
  destination or layout the user has not said is a question first, not a
  task saved on a guess.
- **Design leads** (#5): as now, two lines.

§Open items #1 splits into the marker syntax and the key rule. §Memory #5's
"Never noted" list stays (it is the rule most often broken), #7 goes (D1);
§Open items #4's "the daily note holding what was decided" goes — a done
item leaves a note only for a fact the run records cannot recover (a
real-client verification, an external constraint); a standing authorization
("deploy after the change") lives in the item's stage, not in a note.
Every command the head emits stays a literal (`pier task run --role lead
--model hardest --thinking medium --worktree <branch> --cwd <…>`): the head
fills them each dispatch and the skill is on-demand.

Target: `DISPATCHER` 1 760 → ~1 250.

### D3. `RUN_RESULT` and `WORKER`

`RUN_RESULT` becomes a short list: (1) conclusion — paths, risks, unverified
points, ending on the verified final state (commit, branch, ref pushed,
service active-since); (2) at most one status line, plain text, last, in
English: `Needs your decision — <one line>`; a review ends on `Verdict: clean
| findings | blocked — <why>` instead; (3) no process, long deliverables to a
file; (4) a reversible choice is yours, named; a stop (Working style) is stated
as the result and ends the turn. Target 286 → ~170. The `Approved:` sentence
moves to the owner (D1).

`WORKER` head: "A run that changes a repository's files commits them before
ending its turn, unless its prompt says otherwise" replaces "commit before you
end your turn" (F3) — a review that writes its report, or a task outside a
repo, commits nothing unasked; the never-merge clause per D1. Target `WORKER`
418 → ~280.

### D4. Surface prompt

- The header paragraph becomes one line per fact: the shape; when the sender
  and place repeat; `id` for mentions; `place`; the no-ids form; `lang=` on
  every message and the too-short rule; reply in the most recent `lang=`.
  Target 254 → ~180, worker's 90 → ~60.
- Attachments: outbound and inbound in two sentences; "every read puts its
  content in your context for good" stays. 109 → ~70.
- Instance block unchanged: `apply_patch` is 40 tokens and a per-model
  conditional would change the prompt on `setModel` (a cache miss and a
  moving contract); the board path is what `pier-boards` builds on.

Target `<pier>/AGENTS.md` 759 → ~620; worker's 310 → ~260.

### D5. Skill descriptions

Each of Pier's seven descriptions becomes one sentence: what the skill is for,
the trigger implied ("Publishing a Board — static HTML at a stable Pier
URL."). The "Read before …" clause goes from all seven; Pi's header already
says when to read. Target 634 → ~330 tokens in every session. Bodies are
untouched except `pier-tasks` per D1 (~2 629 → ~2 300).

### D6. `lead(phase)`

Design unchanged (168). Build: #3
(98 tok) splits into integrate and milestone; #4 says the done milestone
names the review and its sha (D11); #6 per D1; #7 goes. Target 611 → ~480.

### D7. Tests assert the contract, not the prose

`roles.test.ts` is rewritten around what code and the CLI parse (F4): each
marker and status line named once with its owner; the launch lines the head
must emit; `MODEL_TABLE` exactly once in `DISPATCHER` and `lead("build")`, in
neither `lead("design")` nor `WORKER`; the negatives that guard regressions
(no literal button label, no `finishing run`, no `Approved: merge`, no
`--until`, no `Reply in the language` in `DISPATCHER`); the surface facts
(boards path, both routes, `apply_patch`, unset address). Plus a size line per
prompt, chars/4 like the Console: `DISPATCHER` ≤ 1 400, `WORKER` ≤ 320,
`lead("build")` ≤ 550, `surfacePrompt()` ≤ 700 — a ceiling in the sense of
AGENTS.md Budgets rule 5, raised with a sentence when the right things are in
there (chars/4 is the Console's metric; the `o200k` counts above are ~10%
lower). `pi.test.ts`'s baseline assertions the same way. The workflow
decisions add seam tests that prose never guaranteed: a review brief carries
delivered steering (D10); an old root cannot finish a newer goal; a lead's
finish needs review evidence at its sha (D11); a clipped finding is recovered
before a repair (D12); a reviewer treats a quoted `Approved:` as inert.

### D8. Loosened: judgement handed back to the agent

A rule stays when code parses its output or a past failure named it; a rule
that dictates how to do what the agent can judge goes. Candidates, by contract:

| Where | Now | After |
| --- | --- | --- |
| `DISPATCHER` #7 | "the user's message wears a 👀 and the status line shows the stage" | goes — UI facts, not a rule |
| `DISPATCHER` #8 | "Its callback opens with a `Goal:` line, which is what to say, and the stage is written once at dispatch with nothing to count" | "a `Goal:` callback is the child's own summary"; how to relay it is the head's |
| `DISPATCHER` #9 | the content-merged branch mechanics (`git merge-tree`, `git cherry` all `-`) | goes — `pier task finish` decides that in code; the head only passes `--remove-worktree` |
| `DISPATCHER` #6 | "The user's words verbatim, your additions after them; never re-summarize" | "pass the user's words on, not a paraphrase" — one clause |
| `DISPATCHER` §Memory #2, #4 | "~25 words / 40 Chinese chars of keywords"; "with the `edit` tool" | "one line, keywords"; tool choice free |
| `lead("build")` #2 | every worker `--model balanced --worktree <branch> --rounds 0`, one worktree each | model per `MODEL_TABLE`; a worktree per worker when workers write in parallel; a sequential worker may work in the lead's own tree while it has exclusive write ownership — the lead neither edits nor integrates until it returns, the tree clean at each handoff (execution serializes by session, not cwd, `tasks/agent.ts`, so the prompt is the guard); reviews the lead's call, subject to D11 |
| `lead("build")` #4 | "one review worker (`--model balanced`, `hardest` for a seam or a risk)" | "reviewed before the done milestone"; tier from the table (it has a review row) |
| surface header | when the sender/place repeat ("a ~10-minute gap, a new day", `[14:23]`), the no-ids form | the shape once, `id` for mentions, the `lang=` rule; the rest is visible in the messages |
| baseline Working style #4 | "never `cd` into that directory, use relative paths, `cd` only to go elsewhere" | the fact only: each call is a fresh shell in `<cwd>` |
| baseline Communication #7 | "the files touched and one line on the result; … at most two one-line items" | "after edits: files touched, result, risk" |
| `reviewPrompt` | "`file:line · issue · fix`" per finding | the `Verdict:` line fixed; each finding names its location, consequence and fix in the reviewer's own form — the evidence stays, the punctuation goes |
| `pier-tasks` §Answering the user about the schedule | a four-bullet format | goes — `pier task list` and the Communication rules suffice |

Kept on purpose: the Communication cap (60/120 words) — the operator's taste,
changed by them; the review's verify-in-one-call; `--name` in the user's
language; "never `--model ?` per message"; "never re-check a child's verified
state"; a worker's own action limits (it never loads the dispatcher or the
skill) — each named a failure that happened.

### D9. Docs

`docs/design/10-continuous-session.md` §Roles and §Open items name the
contracts by owner after D1; `09-tasks-cli.md`'s run-contract paragraph
(line ~295) shortens to point at `RUN_RESULT` and Working style;
`12-model-tiers.md` line ~86 if the preamble wording it quotes changes. No new
doc: this plan is the reasoning, the commit its record.

### D10. A review reads the effective requirement, steering included

`reviewPrompt` quotes the root's first prompt and its `resumePrompt`
(`tasks/goals.ts` ~297); guidance steered to the worker while it ran
(`--run <id> --prompt`, stored and delivered by `tasks/messages.ts`) never
reaches the reviewer, which then flags what the user asked for as unrequested
(review W5/R4 in the report: two decision turns lost). The brief becomes: the
first prompt, then every delivered user/supervisor message to that run
lineage in order, each under a one-line head saying it was steering, the
`Approved:` inertness rule unchanged; a re-entry keeps the earlier accepted
guidance, not only the latest answer. Read from the existing message records;
no second store. Owner: `tasks/goals.ts` + test.

### D11. A build lead's done means the integrated sha was reviewed

`pier task finish --run <lead run>` takes a build lead's current clean HEAD
(`tasks/operations.ts` ~401) on the lead's word; the goal path refuses a
branch that moved past its reviewed sha (~416). Sampled leads fixed runtime
behaviour after their review and declared done without another (L1, L2). The
lead's review of its integrated branch *is* a goal: `pier task run --rounds
<n> --cwd <its tree> --prompt "review …"` from the lead — the skill's "`--rounds
<n>` alone is a goal in `--cwd`" — so the review → fix → review loop, the cap
of n, and the reviewed sha come from `tasks/goals.ts` as they do for the
head's workers, the fix worker holding the tree in exclusive ownership (D8)
while the lead waits on the callback. Not one review: as many as the loop
needs until clean, capped by n like the head's path. `finish` accepts a build
lead only when the newest goal rooted in its tree ended review clean at HEAD,
else refuses naming the reviewed sha and the HEAD — the same refusal a moved
goal branch gets; no new store field. The prompt (D6) says "the done
milestone names the goal and its sha; a material change after it opens
another goal, a wording fix need not". Owner: `tasks/operations.ts` (the lead
branch of `finishDraft`), `tasks/goals.ts` if a goal in a lead's own cwd needs
allowing + tests.

### D12. Findings survive the handoff to the fix

A goal callback clips the result to 3 000 chars and the review to 1 000
(`tasks/callbacks.ts` ~194), head and tail kept; a head that continues a
`still findings` goal by hand writes "fix the two small issues" from the
clipped text and the worker cannot find the second (H3/W5). Inside the loop
`fixPrompt` already carries the full review; the by-hand path gets the same:
`pier task run --run <root> --rounds <n>` on a root whose last review found
things prepends that review's full text to the prompt in code, the head's
words after it. `pier-tasks` says so in one line and drops "recover before
resuming" advice; it also says `--prompt -` with a quoted heredoc for a
prompt with backticks or `<…>` (H4 lost both to shell quoting). Owner:
`tasks/goals.ts` (`resumeWorker`), `skills/pier-tasks/SKILL.md` + test.

### Deferred, with the measurement that would decide

Review cap (3 is a cap; 10 of 17 first reviews were clean, so a lower cap
saves nothing and costs a re-entry on findings); head rotation thresholds and
seed size (5.7–7.4K chars, not the cost); model tiers (all 28 sampled reviews
ran one model — no comparison exists). Each waits on outcome data from the
run records: accepted findings, repair rounds, head interventions, context at
dispatch — `pier task stats` grown by those columns is the first step, not in
this feature.

## Expected result

| Role | Now | After (system prompt) |
| --- | --- | --- |
| head | 4 462 | ~3 500 |
| worker | 2 217 | ~1 750 |
| reviewer / finish | 4 878 | ~4 400 (repo `AGENTS.md` untouched) |
| lead design | 5 532 | ~5 050 |
| lead build | 6 314 | ~5 550 |

About 20% of Pier's own text; every rule kept; no line over ~45 words in a
role file; no rule with two owners in one session. The turns the workflow
decisions remove are not in this table: the report counts a median 2 head
responses per dispatch and ~72K context reads, 1 and ~38K per callback, 97%
of them cache reads — a lost steering or a clipped finding costs several of
those, a prompt line a fraction of one.

## Invariants

- Every parsed syntax keeps its bytes: `<silent>`, `<open>`, `<done>`,
  `<topic>`, `<note>`, `---` + `[label]` buttons, `file://`, `Design final:`,
  `Goal:`, `Verdict: clean|findings|blocked — <why>`, `Needs your decision —`,
  `Approved:`.
- `MODEL_TABLE` stays one constant carried verbatim by both launching
  contracts; the skill never restates it.
- The head's system prompt stays the same bytes every turn (10 §Cache): no
  per-model or per-turn conditionals in the surface prompt.
- A worker still opens without `pier-tasks` and without buttons/attachments.

## Not in this feature

- Pier's own `AGENTS.md` (F5): its own change, proposed to the user separately
  — §Docs, §Comments and the "What the size is" column are candidates for
  `docs/`, which would take a lead's prompt from 5.5K to ~4K.
- The head's seed (2 676 tokens at open) and the per-turn history: 10 §Head
  lifecycle owns those budgets.
- The operator's `SYSTEM.md` (263) and skill package (258): theirs.

## Workers

Two writers, disjoint files (report §7: the four-way split paid three
`npm ci`s and a docs run for dependent wording):

| Branch | Decisions | Files |
| --- | --- | --- |
| `prompt-opt-prompts` | D1–D9 | `agent/roles.ts`, `agent/pi.ts`, their tests, `skills/*/SKILL.md`, `docs/design/09,10,12` |
| `prompt-opt-workflow` | D10, D11, D12 | `tasks/goals.ts`, `tasks/operations.ts`, `tasks/store.ts`, `tasks/callbacks.ts`, their tests, `docs/design/09,10` (the lines those decisions change) |

In parallel off this branch; the lead integrates workflow first, then prompts
(its `pier-tasks` line for D12 follows the code). One review of the integrated
branch at its final sha (D11 applied to this lead), verified by `npm run check
&& npm run lint && npm test` and a re-measure of one fresh session per role.
