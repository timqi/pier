# Design 01 — Skeleton

Goal: a repo that typechecks, lints, tests, and runs a no-op `main.ts`, with
the two seam interfaces defined exactly as in `docs/architecture.md`.

## Deliverables

- `git init`, `.gitignore` (node_modules, dist, *.local, .env)
- `package.json` — name `pier`, `"type": "module"`, scripts:
  `dev` (tsx watch src/main.ts), `build` (tsc), `check` (tsc --noEmit),
  `lint` (eslint or oxlint), `test` (vitest run)
- `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`,
  ES2022, NodeNext modules
- `src/core/types.ts` — copy the normative types from architecture.md verbatim
- `src/main.ts` — logs "pier: nothing wired yet" and exits 0
- Directory stubs: `src/core/ src/agent/ src/channels/ src/web/ src/tasks/`

## Dependencies

Dev only: `typescript`, `tsx`, `vitest`, linter. Zero runtime deps in this step.

## Acceptance

- `npm run check && npm run lint && npm test && npm run dev` all succeed
- `src/core/types.ts` compiles with no imports (pure types)
- No file exceeds its budget (trivially true here)
