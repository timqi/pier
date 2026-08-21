dev:
    npm i
    HOST=0.0.0.0 PORT=3141 PIER_HOME=~/.pier_test npm run dev

stable:
    git rebase main
    npm i
    npm run build
    PORT=3142 node dist/main.js
