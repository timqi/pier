# Model menu — operator-pinned recommendations

Status: planned. Follows the pier-tasks skill dropping its hardcoded model
list (branch task-prompt-surface): rules replaced the ids, but "which few
models this deployment actually uses" still lives nowhere.

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
  `{ provider, id, note? }`, the note one line of intent ("hardest
  reasoning", "cheap bulk"). Empty menu = today's behavior everywhere.
- **Console**: edit the menu next to the provider config; picking from the
  curated list, not free-typing ids.
- **Consumers**:
  1. `availableModels` orders pins first (web picker, IM panel).
  2. task tool gains a `models` operation returning the menu (pins + notes,
     curated list as fallback) — on-demand, zero standing tokens.
  3. pier-tasks skill points at the `models` operation instead of naming ids.

## Non-goals

No per-task model policy, no auto-selection, no new heuristics in
`curateModels`. The menu is advice; validity stays enforced by the live
catalog and its self-correcting error.
