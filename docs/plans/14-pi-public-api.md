# Pi private access — contain it, do not replace it

Status: final. Pi `@earendil-works/pi-coding-agent` 0.87.1.

## Facts

- Only `src/agent/pi.ts` and `src/agent/packages.ts` import Pi; no deep
  (`/dist/`) imports; `packages.ts`, `config.ts`, `credentials.ts`,
  `config-sync.ts` use exported classes and functions only.
- One private access: `src/agent/pi.ts` `loadSystemPrompt` reads
  `_baseSystemPromptOptions` and calls `_preparePromptAndToolLoadout` through
  the `PromptLoadout` cast, so a turn a system input opens on an idle session
  carries the system prompt. Pi builds the loadout only in `prompt()` and in
  `prepareNextTurn`; `sendCustomMessage({ triggerTurn: true })` skips it.
  Upstream bug earendil-works/pi#5581, open, unfixed on `main` (2026-09-28).
- A public-only replacement (turn-openers via `prompt()` plus a provenance
  entry and a pairing rule across history, rewind, listing and live events)
  was designed and rejected: three source files, a stateful rewrite, all to be
  deleted once #5581 ships. The shim stays until then.
- Two public-but-wrong-layer accesses in the same file are fixed now.

## Changes — `src/agent/pi.ts` only

1. **Guard the shim.** In `openSnapshot`, after `createAgentSession`, assert
   `typeof live._preparePromptAndToolLoadout === "function"` and
   `live._baseSystemPromptOptions` is an object; on failure throw
   `pi <version>: prompt loadout shim no longer applies (pi#5581)` so opening
   a session fails loudly instead of running turns without a system prompt
   (principle 5). The `PromptLoadout` comment names #5581 and the removal
   condition: Pi prepares custom-triggered runs itself.
2. **`refreshContext()`** replaces both
   `this.pi.agent.state.messages = manager.buildSessionProjection().messages`
   (`recordRefusal`, `loadSystemPrompt`) — Pi's public refresh, which also
   rebuilds the entry map the assignment skipped.
3. **`followUpMode` via settings.** `openSnapshot` passes
   `settingsManager: SettingsManager.create(cwd, defaultAgentDir())` with
   `applyOverrides({ followUpMode: "all" })` to `createAgentSession` and drops
   `live.agent.followUpMode = "all"`. Pi reads the setting at creation
   (`syncQueueModesFromSettings`); `applyOverrides` is in-memory, nothing
   reaches settings.json. Pi's `session.reload()` re-reads settings.json and
   drops every override (this one and the compaction reserve alike); Pier
   never calls it — a config reload recycles idle sessions instead.

Unchanged, by decision: the `streamSimple` override for `cacheRetention`
(public method on a runtime Pier constructs; Pi has no per-session option),
transcript JSONL reads in `listing.ts` / `system-prompt.ts` (file format,
pinned by golden tests).

Tests (`src/agent/pi.test.ts`): the fake gains `refreshContext` and the
assertions on `state.messages` move to it; a fake without the two private
members makes `open` reject with the shim message; `createAgentSession` is
asserted to receive a `settingsManager` whose `getFollowUpMode()` is `"all"`.

Budget: `agent/` net +14 (2879 → 2893); the sentence: the shim now fails at
open instead of at the first request, and the follow-up mode is set where Pi
reads it.

## Verification

- `npm run check && npm run lint && npm test`.
- Live: `pier task run` a one-shot task; `GET /api/sessions/<child>/system-prompt`
  is 200 before its first reply.
- Live: queue two follow-ups during a turn — both drain in the next turn.

## Removal

When a Pi release closes #5581: delete `loadSystemPrompt`, `PromptLoadout`
and the guard; `systemInput` calls `sendCustomMessage` alone.
