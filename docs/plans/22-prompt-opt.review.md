# Prompt optimization review — workflow correctness before prompt size

Read-only second opinion on `22-prompt-opt.md` and the workflow its prompts encode. Source baseline: `b66f81ec36a5a6623f79bd6e8c5cc7d1443009aa`, branch `prompt-opt`; transcript sample read on 2026-09-30. This report is the only repository change. Recommendations below are proposals, not implemented changes.

The plan's ownership cleanup and shorter rules are useful. The larger opportunity is to stop losing information between stages: user steering does not reach goal reviewers, clipped findings do not always reach repair runs, and a lead's final commit does not have the same review gate as a direct worker's. Fixing those boundaries should save more unnecessary work than shrinking the system prompt alone. Keep the event-driven goal loop, user control of merging, and independent review.

## Evidence and limits

Read the plan first, then the requested prompt/runtime implementation, then the design contracts, task skill and repository instructions, then real JSONL transcripts. Additional source inspection traced requirements, finish eligibility, callback clipping, and delivery. Session IDs below refer to JSONL files under `/home/qiqi/.pier/pi/sessions/`; heads are under `--home-qiqi-.pier-home--`. `Tn` means the nth user or actionable `pier.system-input` message, including steering and callbacks, excluding the session seed and display-only chat-command messages. It is an input boundary, not a tool call or a UI bubble. Some streaming turns span multiple such boundaries.

The minimum detailed sample was five recent heads, three recent completed leads, five implementation workers, and three goal reviews. Additional sessions were read to trace their handoffs:

| Alias | Session ID | Inputs examined / purpose |
| --- | --- | --- |
| H1 | `01a0f0dd-e5a2-70ff-93ae-c4270f23c259` | T1–T14, recent head: prompt work, panews verification, daily report scope |
| H2 | `01a0f038-1cfd-77d1-8d77-7170c55261db` | T1–T26, head after full rotation: wallet work, localized buttons, IM verification |
| H3 | `01a0efd3-7846-7736-8936-07e859793aa8` | T1–T56, head: reviews, approvals, stale goal root, finish and deployment |
| H4 | `01a0ef8a-32a7-7736-8936-07b0fbf3a6f1` | T1–T43, head: branch cleanup, UI fix handoff, notes |
| H5 | `01a0ed73-3a86-732b-a1ea-1210b2839334` | T1–T31, head: workflow decisions and IM feature |
| L1 | `01a0ed96-4cf8-74ef-a19d-d456dfd982f8` | T1–T5, lead: IM status feature, parallel workers, integration and review fixes |
| L2 | `01a0ed8c-15fd-74ef-a19d-d44fde734e26` | T1–T7, lead: workflow-opt2, three workers, review, fix worker |
| L3 | `01a0ed66-037b-732b-a1ea-1206b050a230` | T1–T6, lead: P0/P1 workflow fixes and subsequent cleanup |
| L4 | `01a0ecee-a455-7050-9d3a-1427e3ab5c81` | T1–T6, earlier build lead: design handoff and removed-cwd failure |
| D1s | `01a0ecc5-d156-7050-9d3a-1423e454c8e5` | T1–T8, design lead: actual user choices, finalization, build handoff |
| W1 | `01a0f10e-a703-70ff-93ae-c42aae5bd48a` | T1, panews worker: real fetch, validation, committed result |
| W2 | `01a0f041-22cb-717e-be5b-75c4c48998bc` | T1, button-language worker: dependency setup, prompt/docs change, verification |
| W3 | `01a0f02d-0f09-77d1-8d77-715f7a9fec44` | T1–T2, Lark quote worker and review repair |
| W4 | `01a0f032-ea07-77d1-8d77-7160dae3aaa4` | T1–T3, Rabby hint worker, deployment preapproval steering, review repair |
| W5 | `01a0effd-5437-76c1-a358-50583aefe76c` | T1–T6, IM status worker: lost requirements and incomplete repair brief |
| R1 | `01a0f033-8b39-77d1-8d77-716228b10444` | T1, Lark goal review: two concrete boundary defects |
| R2 | `01a0f034-79cf-77d1-8d77-7164c81d209d` | T1, Rabby goal review: misleading lower-gas-limit advice |
| R3 | `01a0f042-73cc-717e-be5b-75c661a027f2` | T1, button-language goal review: clean with explicit coverage limits |
| R4 | `01a0f008-2876-76c1-a358-505f86dc3b5c` | T1, second IM status goal review: missing user steering |
| R5 | `01a0f00b-3598-76c1-a358-50608385d1c7` | T1, re-entered IM status review: two findings, one lost in the repair handoff |
| F1 | `01a0f012-35d7-76c1-a358-506b6611ba66` | T1–T2, finish run: incorrect removal-only instruction, then approved merge |

Broader counts use the recent transcript files dated September 27 onward, excluding this review's own session. This is an observational sample across rapidly changing versions, not a controlled model comparison. Historical behavior is distinguished below from behavior still present in this checkout.

- Across H1–H5, 65 input boundaries contained a `pier task run` or `pier task finish` invocation. Median assistant API responses per such boundary: 2. Median cumulative context tokens reported across those responses (`input + cacheRead + cacheWrite`): 72,061.
- The same heads had 70 task-callback input boundaries. Median assistant responses: 1; median cumulative context tokens: 38,035.5. About 97.3% of the aggregate context tokens were reported as cache reads. These are repeated context reads, not unique tokens or billed dollars.
- The five initial seeds were 5,677, 6,913, 7,384, 6,322 and 6,282 characters. Three explicitly followed the 60K threshold and two followed an hour idle.
- Of 28 recent goal-review sessions, 24 used the current `review N of cap` wording. Those comprise 17 first reviews (10 clean, 7 findings), six second reviews (4 clean, 2 findings), and one third review (clean). These are review-session counts, not 17 fully observed independent feature lifecycles; re-entry can start another first review. Four older-format reviews are excluded from the current-format breakdown.
- All 28 sampled goal reviews used the same recorded model, `claude-opus-5-5`. This says nothing by itself about which tier is optimal. Provider usage records sometimes report zero cost, so this review makes no dollar-savings claim.

## Ranked proposals

### 1. Give every review the effective requirements, including delivered steering

**Priority:** P0. **Change type:** code + workflow. **Relationship:** extends D2/D6/D10; corrects the assumption that prompt cleanup alone can repair a handoff.

**Evidence.** `src/tasks/goals.ts:297` constructs a review's task from the initial action prompt and, if present, that root's `resumePrompt`. It does not include task messages delivered while the worker runs. Those messages already have durable content and delivery state (`src/tasks/messages.ts:118`, `src/tasks/messages.ts:53`).

W5 T2 received the user's explicit request to stop reposting the status card and remove 👀 when a turn ends. W5 T3 explained that those behaviors were requested by that guidance. Yet R4 T1's complete requirement block contains only the original duplicate-`/status`/context request. It flags the two added behaviors as unrequested. W5 T4 again identifies guidance message `ncmz2ears0g5h9ew`, then ends by asking whether to keep exactly what the user requested. H3 T22 has to answer “keep” on the user's behalf and start another goal. There were also real defects in these reviews, so not every repair round was wasted; the scope dispute was avoidable.

**Proposed change.** Build the review brief from the original requirement plus ordered, delivered user/supervisor guidance across the relevant run lineage. Distinguish requirement changes from automatic review-fix instructions. Preserve the words and their provenance; a reviewer reads any approval as quoted requirements, never permission to act. A re-entry should retain earlier accepted changes, not replace the effective task with only the most recent answer. Use the existing task-message/run records rather than a second conversation store. If the records cannot establish which guidance landed, report that uncertainty instead of silently reviewing against an older specification.

**Expected gain.** Removes false scope findings and repeat decision turns; improves both cheaper and stronger reviewers without changing their models. Measure scope findings reversed because of missing guidance, and user decisions repeated after an already explicit instruction.

**Cost/risk.** Moderate: reconstructing the lineage and defining which delivered messages are requirements needs seam tests. Dumping the whole worker transcript would reintroduce context cost and implementation bias. Use the narrow requirement history, with superseded decisions identified.

### 2. Make lead completion mean that the final integrated commit was reviewed

**Priority:** P0. **Change type:** workflow + code, then prompt wording. **Relationship:** strengthens D6; challenges D9's replacement of the lead review rule with only “reviewed before the done milestone.”

**Evidence.** The direct goal loop stores the reviewed HEAD (`src/tasks/goals.ts:178`), returns immediately on `clean` (`src/tasks/goals.ts:234`), and `finishDraft` rejects a moved goal branch (`src/tasks/operations.ts:416`). For a build lead, the same function instead takes the current HEAD when no reviewed goal exists (`src/tasks/operations.ts:401`, `src/tasks/operations.ts:416`). The lead's assertion that it reviewed the branch is not equivalent evidence.

L1 T5 receives its integrated review, changes runtime and prompt behavior, runs checks, and declares the feature ready without launching another review. L2 T6 sends eight review findings to a fix worker; T7 merges that worker, runs checks, and declares nothing outstanding, again without a fresh review. L3 T4 similarly fixes three doc/message nits and ends. These cases have different risk: runtime changes warrant another inspection more clearly than wording fixes. The current protocol does not record that distinction.

**Proposed change.** Reuse a review result tied to the final integrated SHA for lead builds. After substantive fixes, have an independent worker review that final state; unchanged areas need not receive the same exhaustive analysis again. The done milestone names that review and SHA. Finish should resolve the corresponding evidence instead of treating arbitrary clean lead HEAD as reviewed. If the operator wants a narrow exemption for nonbehavioral corrections, make it explicit and auditable rather than implicit in “the lead acts on findings.” Do not add a new supervisor model to decide this.

**Expected gain.** One meaning of “reviewed and ready” on both launch paths, fewer regressions escaping through the lead path, and less need for the head or user to reread implementation history.

**Cost/risk.** Moderate: associate existing lead/review runs with the reviewed commit. This can add a short follow-up review after material repairs; that is deliberate coverage, not an efficiency regression. Avoid requiring several clean reviews of unchanged code.

### 3. Preserve actionable findings through clipping and repair handoffs

**Priority:** P0. **Change type:** prompt + workflow; targeted callback code if needed. **Relationship:** extends D3; qualifies D9's removal of the finding format; adds behavioral coverage to D7.

**Evidence.** Goal callbacks contain at most 3,000 characters of the latest worker result plus 1,000 of the review (`src/tasks/callbacks.ts:194`). The clipping function retains the head and tail, potentially losing the middle where findings occur (`src/tasks/callbacks.ts:110`). This is reasonable for a human summary, but it is not a complete repair brief.

R5 T1 lists a possible invisible `/status` answer and a stale acceptance sentence. H3 T23 resumes the worker with “fix the two small issues,” naming only the documentation line. W5 T6 fixes documentation and explicitly says it lacks the full third review and cannot match both findings. A later clean review may independently resolve the concern, but this handoff did not convey it. The task skill already provides recovery for clipped results (`skills/pier-tasks/SKILL.md:79`).

There is another concrete transport loss: H4 T29 embeds literal backticks and `<slug>` in a shell double-quoted `--prompt`, then immediately sends a correction because shell expansion lost the text. `--prompt -` already exists (`skills/pier-tasks/SKILL.md:11`).

**Proposed change.** When a callback is clipped and the next action depends on findings, recover the full review before handing it to the worker, or let the runtime forward that review by run ID. A callback sufficient for announcing readiness is not necessarily sufficient for repairing it. Keep compact findings with location, consequence and proposed correction, allowing prose flexibility. Require complete actionable findings rather than one particular punctuation template. Prefer stdin with a quoted heredoc for multiline prompts and literal code.

**Expected gain.** Fewer corrective messages, incomplete fixes and rediscovery reviews. Maintains short head context for ordinary completion callbacks while retrieving detail only when needed.

**Cost/risk.** Low for prompt/skill changes; moderate if adding a direct review-reference repair path. Recover only settled results and retain the existing no-polling rule. Do not enlarge every callback indiscriminately.

### 4. Keep three as a cap; make findings actionable before tuning the cap

**Priority:** P1. **Change type:** prompt + workflow. **Relationship:** corrects D2's “defaults” wording and extends D9; no blanket reduction in reviews.

**Evidence.** The current default is at most three reviews, not three mandatory reviews: `src/tasks/goals.ts:134`, `src/tasks/goals.ts:234`. A cap of one gives one review and no automatic repair after findings (`src/tasks/goals.ts:235`). Ten of seventeen observed first reviews were clean. Lowering their cap from three to one would save no review calls; on a findings case it can instead force an extra head/user turn to re-enter the loop.

Reviews earned their cost: R1 T1 catches a quoted `/stop` no longer parsing as a command and a missing timestamp producing a `NaN` quote header. R2 T1 catches advice implying that a lower gas limit merely leaves a remainder. R3 T1 returns clean while separately noting missing live language verification and an optional English syntax example. Thus this sample does not justify treating all “not verified” notes as findings, or claiming that reviewers universally do so.

**Proposed change.** Say “up to three reviews, stop at the first clean verdict” in the role, CLI skill and relevant docs. Define findings as actionable defects or unmet acceptance criteria; distinguish optional improvements and coverage limits. Lack of evidence for a required safety/acceptance property can block; merely not running every possible environment should not automatically create a repair loop. Keep three by default until complete goal-level measurements show a better choice. Allow zero for explicitly review-only/research work or a narrowly approved trivial change, not as an automatic response to a small diff. Keep the user's explicit round count authoritative.

**Expected gain.** Avoids optimizing away useful repair capacity, reduces speculative scope expansion, and makes later cap experiments meaningful.

**Cost/risk.** Low for wording; reviewer calibration needs examples. Severity alone must not hide a real acceptance failure. Track accepted findings, repeated findings, clean round, and end-to-end head interventions, not only review count.

### 5. Keep user-controlled finish, but carry prior authorization and the current goal root explicitly

**Priority:** P1. **Change type:** workflow + focused code. **Relationship:** qualifies D2/D3/D9; supports moving branch-content mechanics out of the dispatcher.

**Evidence.** H3 T24 receives a clean review for new root `2e48ht9e162gvqnb`, but its open marker still names original root `6x7qcgcmsdjjrytd`. T25 invokes finish with the old root. F1 T1 is consequently told to remove only, discovers unmerged changes, and stops. H3 T27 and F1 T2 spend additional turns repairing this. The current checkout already rejects an earlier root and names the newer one (`src/tasks/operations.ts:402`); it also fixes the removal-only fallback (`src/tasks/operations.ts:423`). Those historical bugs should not be reported as still unfixed.

Prior authorization can already work: H3 T50 records “deploy directly after the change”; T51 and T54 continue through merge and deployment without another permission question. H5 T23 similarly records conditional authorization to merge and restart two features. Conversely, current `roles.ts:35` describes the clean callback as always a merge question.

**Proposed change.** State the actual policy: require user authorization for merge/removal/restart/deploy; consume existing authorization when it covers the proposed action and conditions. Never infer it from a review verdict. Carry the latest root from the `Goal:` callback into the item's action reference, keeping older runs only as history if needed. Preserve separate merge, removal, and release scopes; authorization for one does not supply the others. Persist or derive that scope from existing run/message provenance so rotation does not make a daily note the only copy. Keep finish in the main checkout with branch/SHA/clean-tree rechecks; unusual content-equivalence cases can still need an agent.

**Expected gain.** Fewer redundant permission turns and wrong-root retries without surrendering user control. Removes Git mechanics from the head's prompt because the finish implementation owns them.

**Cost/risk.** Moderate if authorization becomes machine-readable; low for clarifying the prompt. The highest risk is broadening an old approval to new scope. Bind it to the task, actions and conditions, and reject ambiguity. Do not claim this review proves a need for fully automatic deployment.

### 6. Delegate investigations by their size and effect, not merely by whether a tool runs

**Priority:** P1. **Change type:** workflow + prompt experiment. **Relationship:** extends D2/D9; keeps implementation and substantial verification in children.

**Evidence.** `src/agent/roles.ts:27` permits read-only locating but delegates any project-command verification. The task skill says quick commands belong in the caller's own shell (`skills/pier-tasks/SKILL.md:38`), leaving a head-specific ambiguity. H1 T4 answers whether panews works by locating it, inspecting history, running `node validate.mjs`, making HTTP probes, and checking script headers. This directly exceeds the head's project-verification rule. Its result was useful, but the growing investigation belonged in a child under the current contract.

Delegation itself is not free: the 65 observed run/finish dispatch boundaries have a median two assistant responses and roughly 72K cumulative context reads, before any child's work. Callback boundaries add their own reads. This does not prove that every quick probe should move to the head, but it argues against a categorical rule that creates a child for one known fact.

**Proposed change.** Keep a bounded exception for locating or reading one fact needed to answer or dispatch: a known local file, one read-only metadata query, or a narrow status check. No edits outside home, diffs requiring review, test suites, dependency installs, browser sessions or iterative debugging. Once uncertainty expands beyond that bound, delegate the investigation with its evidence. Clarify that the skill's quick-shell advice remains subordinate to the caller's role. Test the exception against recorded cases before broadening it.

Also distinguish bounded execution from product design: H1 T5 creates a recurring report using an inferred crypto/Web3 scope; T6 pauses it when the user says to discuss topics, destination and layout first. That decision needed product requirements, not a cheaper worker or a stronger model. Establish the intended recurring output before scheduling it when those material choices remain open.

**Expected gain.** Fewer unnecessary sessions for genuinely small lookups, less temptation to ignore the dispatcher contract, and fewer recurring jobs built on guessed requirements.

**Cost/risk.** Low code cost, real behavioral risk: “quick” can become unlimited investigation. Evaluate head tool calls, time to dispatch and scope violations; do not substitute an arbitrary universal command-count rule for judgment.

### 7. Reduce worker/worktree overhead where ownership is genuinely sequential

**Priority:** P1. **Change type:** workflow; code only if enforcing shared ownership. **Relationship:** conditionally supports D9's shared-tree proposal; changes the plan's own worker split.

**Evidence.** L1 T1 creates two branches for independent core and web work, then waits for core before launching Lark at T3: parallel isolation and dependency ordering are useful here. L2 ends with the lead plus five child/review/fix worktrees to account for (T7). W2 T1 has to discover that its new worktree lacks `node_modules`, run `npm ci`, and retry checks. L1 T2 and L2 T5 also encounter dependency setup. The plan's four workers touch a small coupled prompt change: roles and baseline both own parts of `roles.ts`, while docs must follow the final contracts (`docs/plans/22-prompt-opt.md:304`).

**Proposed change.** For this prompt rewrite, prefer one implementation worker plus independent review, or two workers with demonstrably disjoint ownership if parallel work saves wall time. Let the implementer update directly affected contracts/docs together rather than paying another startup solely for dependent wording. For larger leads, keep separate trees for parallel writers. A sequential child may use the lead's tree only while it has exclusive write ownership; the lead must not edit or integrate until it returns, and the tree must be clean at transfer. An independent read-only review may inspect the idle branch without another tree.

This relaxation needs care: task execution serializes by session, not cwd (`src/tasks/agent.ts:65`), so different sessions sharing a directory are not protected by that queue. Keep a prompt-level exclusive handoff first, or add a narrow guard if shared-tree usage becomes common; do not assume D9's “sequential” label enforces it.

**Expected gain.** Fewer dependency installs, context reloads, merge commits and cleanup decisions. Preserves parallelism where the feature has independent work.

**Cost/risk.** Low for changing decomposition; moderate for runtime enforcement. Concurrent edits in a shared tree are a worse failure than extra worktrees. Do not delete existing user worktrees automatically. Retain the main-checkout finish path: L4 T6 actually lost the ability to run commands after removing its own cwd, the failure now documented in `AGENTS.md:157`.

### 8. Keep a fresh build lead for real design handoffs; make the handoff complete and reproducible

**Priority:** P2. **Change type:** workflow + small prompt change. **Relationship:** supports D6's phase split, adds a requirement D10 should document.

**Evidence.** D1s T2–T3 captures a substantive user decision: review difficulty should be judged by the task, without a maintained seam-filename auto-escalation list. T5 adds the Needs You click target. T7 incorporates it and asks for finalization; T8 gets the user's confirmation and emits `Design final:`. L4 T1 opens fresh with `Build per` and reads that plan. This is a useful separation of product choices from execution, not merely another model hop.

The current handoff is an absolute file path (`src/agent/roles.ts:31`, `src/agent/roles.ts:76`); the doc is “the whole state” (`src/agent/roles.ts:80`). An absolute path alone does not identify the finalized revision or prove that constraints discussed in the design session reached the builder. L4 T1 discovers a stale migration number in the plan and substitutes the actual next number, illustrating why the builder must still reconcile source facts.

**Proposed change.** Keep the fresh lead when a user-finalized design has meaningful scope/architecture choices. The handoff names the plan revision, acceptance criteria, non-goals, settled choices, unresolved questions, affected paths, and remaining authorization boundaries. These belong in the existing plan and a short launch reference, not a duplicate handoff document. Keep routine source facts discoverable rather than freezing them into design prose. A simple repair should go straight to a worker; do not manufacture a design phase or require a lead solely to write a plan it immediately implements.

**Expected gain.** Preserves useful context reset while reducing rediscovery and scope drift. Makes completion reviewable against what the user finalized.

**Cost/risk.** Low. Excessive templates can become another prompt tax; include only decisions that affect execution. Automatic design/build continuation must still wait for the user's actual finalization.

### 9. Fix memory ownership and action identity before changing rotation thresholds

**Priority:** P2. **Change type:** prompt + workflow; targeted state projection if required. **Relationship:** extends D2's memory rewrite and D9; challenges treating seed/history as irrelevant to this optimization.

**Evidence.** The head is told not to note run IDs, merges, tests or rules already in contracts (`src/agent/roles.ts:45`), but to write a daily note when an item finishes (`src/agent/roles.ts:53`). That closing instruction encourages completion bookkeeping. H3 T38 notes the rule about using the newest goal root, even though the runtime and skill already own it; H3 T7 and H2 T9 note deployments partly because they also carry unresolved live-validation facts. H3 T50 and H5 T23 store temporary action authorization in daily notes, which is operational state rather than durable knowledge.

`MainChain.seed` already separates open items, unsuccessful/in-flight runs, memory, daily notes and last exchanges (`src/core/chain.ts:244`). The sampled seeds are about 5.7–7.4K characters, so there is no evidence here that seed size is the dominant cost. Rotation is checked only on user input, with 60K as the full threshold (`src/core/chain.ts:205`); callbacks alone rely on compaction. The design explicitly documents that choice (`docs/design/10-continuous-session.md:92`).

**Proposed change.** Replace “completion leaves a note” with “note only a new durable fact or a still-relevant fact the task records cannot recover.” Store task stage, latest actionable root, pending verification and scoped approval with or derivable from the existing open item/run provenance; do not make memory another task ledger. Keep memory for preferences and decisions, and the daily note for facts such as real-client verification or an external constraint. Preserve the distinction between “deployed” and “verified in the real client.”

Keep current rotation thresholds initially. Measure cache-write/compaction cost and dispatch quality by context size before shortening sessions. If callback-only growth is a problem, compact callback bodies or reconsider a safe idle rotation point using the existing chain; do not introduce a second conversation history.

**Expected gain.** Less stale or contradictory state after rotation, fewer wrong-root actions, and smaller notes without losing user decisions.

**Cost/risk.** Low for the note-rule contradiction; moderate for explicit action provenance. Over-pruning memory can lose external facts or authorization. Replaying a rotation with an approved-but-unfinished task is a necessary acceptance case.

### 10. Apply prompt ownership cleanup with semantic exceptions and behavioral checks

**Priority:** P2. **Change type:** prompt + tests + docs. **Relationship:** supports D1–D5 and D7/D10 with changes; narrows D9. The plan contains no D8 heading, so no D8 behavior can be assessed or invented.

**Evidence.** The plan correctly identifies dense multi-rule bullets and repeated language/approval/result instructions. Prompt assembly is centralized in `src/agent/pi.ts:774`; this is a good place to retain stable role-specific text. But a single owner is not the same as a single occurrence for every audience: a worker never loads the dispatcher or `pier-tasks`, so worker action limits must remain explicit (`src/agent/pi.ts:775`).

D1 would leave reply language only to the `lang=` surface rule. Fresh worker task input can lack such a header: `src/tasks/agent.ts:123` derives language from that new session's history. W1 T1 and W2 T1 start with a run tag and mixed Chinese/English task, without `[lang=…]`. Retain a fallback to the request's language when no header exists, or pass language from launch provenance. H3 T4's English button click is itself stamped `[lang=en]`; its subsequent English callbacks therefore cannot be diagnosed merely as the model ignoring a Chinese-language rule. The literal-label fix is already in this checkout (`src/agent/roles.ts:35`); do not report it as missing.

D3's proposed “a run that changes files commits” also needs narrowing: an implementation in a Git worktree commits its intended changes unless explicitly instructed otherwise. A report artifact, a read-only review that writes its requested report, or a non-repo task should not become an unsolicited commit. Separate build, review and finish instructions within their stable role/run contracts. Approval quoted inside a review remains inert (`src/tasks/goals.ts:58`).

**Proposed change.** Implement shorter rules and one authoritative definition, while retaining the minimum audience-specific instructions each role actually needs. Keep triggers that prevent costly misuse of a skill even when shortening descriptions; do not remove all explicit triggers solely because they share wording. Preserve finding evidence even if D9 removes a rigid template. Do not remove the dispatcher instruction to trust a child's verified state.

Replace prose-pinning tests as D7 proposes, but add behavioral acceptance cases: a reviewer never treats quoted approval as authority; delivered steering reaches its requirement brief; an old goal root cannot finish a newer goal; a clipped finding is recovered before repair; a preapproved action survives rotation; a lead cannot finish an unreviewed material revision. Parser tests prove syntax acceptance, not that the model follows a shorter prompt. Evaluate a small fixed set of recorded situations on the actual cheap/balanced pins after rewriting. Compare compliance and unnecessary turns, not just length. Keep token accounting consistent: the plan's measured `o200k_base` counts and its proposed chars/4 ceilings are different metrics.

**Expected gain.** The plan's readability and size benefits without deleting fallback behavior or weakening critical role boundaries. Behavioral cases make future wording changes safer than exact-sentence assertions.

**Cost/risk.** Low-to-moderate. Model evaluations are variable and cost money; use a fixed small sample and report failures. Do not move repository rules to on-demand docs merely to improve the startup number unless the relevant agents still receive the constraints before acting.

### 11. Optimize context traffic and model assignment with outcome data

**Priority:** P2. **Change type:** measurement + workflow; prompt/model changes after measurement. **Relationship:** qualifies the plan's cost argument and model-table preservation in D1/D6/D7.

**Evidence.** `docs/plans/22-prompt-opt.md:68` says the system prompt's price is paid at open/rotation, not per turn. Caching reduces repeated cost; it does not generally make reads free. The sampled head callbacks still report roughly 38K median cumulative context tokens per turn, mostly cached. The initial prompt's proposed reduction is only one component of those reads. Task runs deliberately request short cache retention (`src/tasks/agent.ts:80`), while the head requests long retention (`docs/design/10-continuous-session.md:103`). That split is sensible as a default, but the comment that task calls always arrive seconds apart is too broad for an interactive lead waiting for workers or a human.

L1 T1 alone reports about 4.23M total tokens across 49 tool calls; L2 T1 about 2.13M across 32. Those are cumulative repeated contexts, not single context windows. They show that reading/coordination strategy matters more than a few hundred role-prompt tokens. W2's small prompt/docs edit still incurs fresh dependency setup and a complete repository test run, followed by a separate review. Required checks should remain, but repeated unchanged validation and broad reads should need a reason.

The table assigns hardest to all leads, balanced to implementations and cheap to research/mechanical tasks (`src/agent/roles.ts:10`). In the recent sample, all goal reviews used one model, so there is no comparative evidence that a cheaper reviewer would retain the same findings. D1s T3 explicitly rejects automatic escalation from a seam filename, a user preference that should survive the rewrite.

**Proposed change.** Keep the head on the operator's selected default and preserve stable prompt bytes during a session. Do not switch models per callback to save a small amount while disrupting continuity/cache. Keep cheap for deterministic finish and bounded extraction, balanced for ordinary implementation, and stronger review for actual risk/uncertainty. A clear integration lead or research task may warrant a different tier than its label suggests; judge the work, not the role name or path list. Treat a live/authenticated research task as potentially more complex than a summary.

Use existing run/model/usage records to compare end-to-end cost: accepted findings, repair rounds, head interventions, tool/API failures, elapsed time, cache reads/writes and context at dispatch. Count time waiting for the user separately. Test a cheaper tier on low-risk mechanical cases with an independent check before changing defaults. Measure lead idle gaps before changing its cache TTL; no new provider-specific cache mechanism is justified by this sample. Reduce broad rereads and duplicate work first, then assess the prompt rewrite's actual contribution.

**Expected gain.** Savings grounded in finished-task outcomes instead of prompt-token estimates or model labels. Avoids trading a cheaper call for extra repair and approval turns.

**Cost/risk.** Low if derived from existing records, moderate for a controlled comparison. Price data and actual pin assignments must be recorded at execution; provider-reported zero cost is not evidence that a run was free. No billed-cost or latency improvement has been verified by this review.

## Decision disposition and implementation order

| Plan decision | Review disposition |
| --- | --- |
| D1 | Keep ownership cleanup; retain audience-local action limits and a no-`lang=` fallback. |
| D2 | Keep short rules; clarify review caps, prior authorization, effective handoffs and memory ownership. |
| D3 | Keep compact results; distinguish implementation/review/finish, and commit only within the task's authorization. |
| D4 | Keep shorter surface facts and stable bytes; do not mistake language metadata behavior for prose noncompliance. |
| D5 | Shorten descriptions, preserving meaningful triggers; measure actual fresh/cached cost. |
| D6 | Keep design/build phase separation; require final integrated review evidence for build completion. |
| D7 | Remove prose-pinning assertions; add behavioral seam cases and limited model replay. |
| D8 | Absent from the supplied plan. |
| D9 | Accept removing UI narration and Git mechanics from the dispatcher; condition shared trees on exclusive ownership; retain actionable finding evidence and a real final-review gate. |
| D10 | Update contracts after workflow choices settle, particularly cap semantics and lead finish evidence; avoid merely documenting weakened wording. |

First fix effective requirements and complete repair handoffs, then align lead completion with reviewed commits. The prompt rewrite can proceed as a small coherent change alongside those separately scoped runtime fixes, with the revised semantic exceptions above. Defer changes to review caps, rotation thresholds and model defaults until measurements distinguish avoidable coordination from useful review. This is a priority order, not a request to expand the prompt-only implementation silently.

## Keep as is

- The goal state machine performs review/fix transitions without a head model turn for every step; a clean review ends the loop immediately (`src/tasks/goals.ts:224`).
- Callback batching and transcript-proven delivery, including crash recovery and visible failure paths (`src/tasks/callbacks.ts:167`, `src/tasks/outbox.ts:55`). No polling agent or second progress ledger.
- User control of merge, worktree removal and release actions; build sessions do not remove their own cwd; finish checks the authorized branch state from the main checkout.
- Independent review: the command-routing, timestamp and gas-limit findings in R1/R2 are concrete evidence of value.
- Stable system-prompt bytes, append-only session inputs, role-local skill exposure, and Pi-owned compaction/session machinery.
- Memory for durable facts, open items for current work, and Git/run transcripts for reconstructible execution facts; repair their boundaries instead of adding another memory system.
