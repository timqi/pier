dev:
    npm i
    PIER_TITLE='>t' HOST=0.0.0.0 PORT=3141 PIER_HOME=~/.pier_test npm run dev

stable:
    git rebase main
    npm i
    npm run build
    PORT=3142 node dist/main.js

release bump="patch":
    test "$(git branch --show-current)" = main
    git pull --ff-only
    npm i
    npm run check
    npm run lint
    npm test
    npm run build
    git push
    npm version {{bump}}
    git push --follow-tags
