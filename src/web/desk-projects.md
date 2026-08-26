# Projects

The index the desk routes from. One entry per project. The desk reads this file
before it delegates anything, and it will **not** guess a path that is not
here — if work has nowhere to go, it asks you to add an entry.

Keep it short. This file is read on most turns; a paragraph per project costs
tokens on every one of them.

**Write the canonical path.** Get it with `realpath <dir>` and paste that. A
symlinked spelling of the same directory is a different project as far as
shared memory is concerned, so an alias here quietly splits a project's facts
in two.

Format, per entry:

```
## <name>
- path: <absolute, canonical>
- what: <one line — what this project is>
- standing: <optional; instructions every delegation into it should carry>
```

---

## EXAMPLE — pier

> This entry is an example shipped with the template. Replace or delete it.

- path: `/home/you/code/pier`
- what: the Pier workspace itself — TypeScript, Node 24, `npm run check` and
  `npm test` before anything is called done.
- standing: read `AGENTS.md` first; never modify a file another agent is
  working in without saying so; report `path:line` for every claim about the
  code.

## EXAMPLE — ops

> This entry is an example shipped with the template. Replace or delete it.

- path: `/srv/ops`
- what: deployment scripts and the host inventory for the boxes this instance
  runs on.
- standing: read-only unless the request explicitly asks for a change; never
  run anything that restarts a service — propose the command instead.
