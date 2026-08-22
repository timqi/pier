# Model menu — operator-pinned recommendations

Status: shipped (branch model-menu). Follows the pier-tasks skill dropping
its hardcoded model list (branch task-prompt-surface): rules replaced the
ids, and the menu now carries "which few models this deployment actually
uses".

## Problem

The curated catalog (`agent/models.ts`) filters noise mechanically —
non-reasoning, `-latest`, dated duplicates — but cannot know that a whole
generation is legacy here, or that this operator pays for one vendor and not
the other. That is a deployment fact, like `publicUrl`: owned by the
operator, told to the agent, never guessed by heuristics or baked into a
skill that drifts.

## Design

One source, three consumers.

- **Settings**: a `modelMenu` list in `SettingsStore` — entries of
  `{ provider, id, thinking?, note? }`: the usual reasoning level as advice,
  the note one line of intent ("hardest reasoning", "cheap bulk"). Empty
  menu = prior behavior everywhere. Boundary-checked by `normalizeModelMenu`
  (≤32 entries, notes ≤200 chars, thinking a real level).
- **Console**: Settings → Models edits the menu; entries are picked from the
  live catalog, never free-typed.
- **Consumers** (all shipped):
  1. `pinFirst` (agent/models.ts) orders pins first in every picker — the
     factory and session lists both read the menu per call, so the web
     picker, the IM panel and `/api/models` agree.
  2. task tool `models` operation returns `{source: "menu"|"catalog",
     models}` — on-demand, zero standing tokens.
  3. pier-tasks skill points at the `models` operation instead of naming ids.

## Non-goals

No per-task model policy, no auto-selection, no new heuristics in
`curateModels`. The menu is advice; validity stays enforced by the live
catalog and its self-correcting error.
