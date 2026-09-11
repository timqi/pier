dev:
    NODE_ENV= npm i
    PIER_TITLE='>t' HOST=0.0.0.0 PORT=3143 PIER_HOME=~/.pier_test npm run dev

stable:
    git rebase main
    npm i
    npm run build
    NODE_ENV=production PORT=3142 node dist/main.js

release bump="patch":
    test "$(git branch --show-current)" = main
    git pull --ff-only
    # CI on this exact commit is the gate; release.yml runs the same steps again on the tag.
    gh run list --workflow=ci.yml --commit $(git rev-parse HEAD) -L1 --json conclusion -q '.[0].conclusion' | grep -qx success
    npm version {{bump}}
    git push --follow-tags
    gh run watch --exit-status $(sleep 5 && gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')

# Non-blank, non-comment lines per area, tests excluded — the Budgets table in AGENTS.md.
size:
    #!/usr/bin/env bash
    count() { cat "$@" | grep -v '^\s*$' | grep -vcE '^\s*(//|/\*|\*)'; }
    for a in core channels web agent tasks websearch boards; do
        printf '%-11s %6s\n' "$a" "$(count $(find src/$a -name '*.ts' -not -name '*.test.ts'))"
    done
    printf '%-11s %6s\n' root "$(count $(ls src/*.ts | grep -v '\.test\.ts$'))"
    echo; echo "modules over 750:"
    for f in $(find src -name '*.ts' -not -name '*.test.ts'); do n=$(count "$f"); [ "$n" -gt 750 ] && echo "  $n $f"; done | sort -rn
