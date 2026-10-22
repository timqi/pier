# Native client (design)

A desktop shell around the web workbench, for people who run more than one
Pier: one window, every instance, one unread count, native notifications.
macOS first, Linux the same code. The web UI stays the only chat and Console
implementation ([03](03-web-workbench.md)); the shell adds only what a
browser tab cannot. An experiment: it earns a release when it is used daily
for a few weeks, and is deleted whole if it is not.

## Shape

- **Tauri 2** (`native/`): a Rust shell over the system webview (WebKit on
  both platforms), one webview per open instance, each loading `<url>/app/`. No
  bundled browser engine; the Rust side is instance bookkeeping, the tab
  bar, the badge and the notification call, nothing about chat.
- **Instance** = `{name, url, closed}` in the shell's own store
  (`~/.config/pier-client/instances.json`; a debug build keeps its own list
  in `pier-client-dev/`, as its cookie stores are not the bundle's). Auth is
  the instance's own: each webview keeps a persistent cookie jar of its own, and the operator signs in
  with the password, a passkey or a `pier login` link as in a browser. The
  shell holds no credential and opens no HTTP connection of its own; a local
  instance's port check is a bare TCP connect, and its sign-in link comes
  from the `pier login` CLI straight into its webview.
- **Open on demand**: a tab is an open instance, in the list's order; only
  an open instance has a webview, so a closed one costs nothing. `+` pops up
  the list, the open ones checked: picking one opens its tab (or shows it),
  then Add Instance…, Add Local Instance… ([below](#local-instance)), then
  Remove and Delete Data ▸ per instance. A tab's `×` closes it and destroys its webview; the instance stays listed and keeps its
  data store, so reopening finds it signed in. Which tabs are open is the
  list's `closed` flag, so a restart reopens the same tabs, the first shown.
- **A closed instance is unreachable**: no SSE stream, so no native
  notification, no unread count and nothing on the Dock / taskbar badge until
  it is opened again. Accepted as the price of not running it.
- **Tab bar**: one 38px row across the top, a tab per open instance (dot in the
  instance's accent, name, red unread count), then `+`; the instance's page
  fills the window below. A tab is a 28px rounded pill with a 14px name, 180px wide until the
  window is too narrow, its name truncated with an ellipsis; the shown one is
  raised on `Canvas`, its `×` always visible, the others' only on hover. On
  macOS the traffic lights keep the system's position, about 3px above the row's centre line. Click switches the visible webview, the other open
  ones stay mounted so SSE streams and composer drafts survive a switch. Add = paste a
  URL or a `pier login` link into the field Add Instance… opens (sets url and signs in
  at once) and opens its tab; Remove and Delete Data removes it with its cookie jar and storage
  (macOS: its WebKit data store; Linux: its data directory), double-click on
  the name renames, drag reorders. `name` defaults to the instance's `PIER_TITLE`, read from the
  page title. An error shows as a red toast over the bar for 8s; a click
  dismisses it.
- **Origin guard**: before adding, a hidden throwaway webview (no cookie
  jar, no IPC) loads `<origin>/login`, which every Pier serves signed out
  titled `Pier`; a different title, no title within 2s of the load finishing
  (WebKit reports the title after the load), a redirect off the origin or 10s
  without an answer shows a warning, and submitting the same input
  again adds it anyway. http and https are both accepted.
- **Navigation**: an instance's tab loads only its own origin (scheme, host
  and port; `about:`/`data:` frames aside), a `target=_blank` link to it
  included; every other URL, another Pier's included, opens in the system
  browser, a cross-origin redirect and a foreign iframe too.
- **IPC**: the instance's three commands are a capability added at mount
  for its webview label and its origin alone (`remote` = the origin); the
  tab bar's are local-only (`capabilities/tabs.json`). A foreign page has no
  IPC even if it were loaded.
- **Title bar**: the tab bar is the title bar. macOS keeps its traffic
  lights over the bar's left end (overlay title bar, hidden title); elsewhere
  the window has no system frame and no menu bar, and the bar draws
  minimize, maximize and close at its right end, with `⋯` before them
  popping up the Instances menu, which macOS keeps in its menu bar;
  right-clicking a tab pops up its own, Reload. The bar's empty space drags the window, a double
  click maximizes or restores; on Linux each webview's outer 5px resizes the
  window, unless it is maximized or fullscreen. On Windows only the shadow's
  frame outside the left, right and bottom edges resizes; the top edge lies
  under the bar and does not.
- **Reload**: the shell reloads the webview, not the page's script; on
  Linux it always terminates the instance's page process first (each
  instance has its own data store, so its own process) and reloads in a new
  one, so the first press reloads a hung page.
- **Layout**: the bar is a fixed-height webview; the shell positions the
  webviews on resize, except on Linux, where GTK packs them in the window's
  vertical box, the bar first at its height, the shown instance taking the
  rest.

## Local instance

A Pier on this machine, started and stopped with the shell; for a desktop,
not a server, so no launchd or systemd unit: quitting the app stops it.

- **Command**: `+` → Add Local Instance… opens the add field holding the
  command that starts Pier, prefilled with `<pier's absolute path> serve`
  from an interactive login shell (`$SHELL -lic 'command -v pier'`; a GUI
  app's PATH lacks fnm's and Homebrew's, and zsh reads `~/.zshrc` only when
  interactive), empty when it finds none; a shell that does not answer in
  20s is killed and its error shown, the field opening empty. The user may edit
  it — a dev build, `PORT=3200 pier serve`. It runs in that login shell too,
  so a bare `pier` works.
- **Instance** = `{name, url, closed, command}`; its url is
  `http://127.0.0.1:<port>`, the port the command's own `PORT=` word
  assigns, else 3141; a `PORT` the profile exports is not seen.
- **Start**: on add, on the app's start when its tab is open, and on opening
  its tab, a TCP connect to the port decides. Answered: a Pier already runs
  there, connected to as is and marked `external` in `+`'s menu; quitting
  leaves it running. Not answered: the shell spawns the command in its own
  process group, output appended to `~/.pier/logs/serve-<port>.log`, and
  loads the tab once the port answers (60s; a command that exits first shows
  its status and the log's path). Either way the port is then probed as any
  added instance, so a listener that is not Pier warns; a warned add stops the
  Pier it spawned, and a forced one spawns its own for the instance it adds.
  One start runs per instance at a time: an open during it waits for it. A spawned Pier that
  has exited is started again on the next open, and picking a tab whose start
  failed retries it.
- **Close**: closing or removing a local tab stops the Pier the shell spawned
  for it, held as a quit is when its page counts a session busy (a second
  close within 8s goes ahead), then SIGTERM and SIGKILL after 10s; an
  `external` one is left running. An open meanwhile waits for the stop and
  spawns it again; a tab closed while its Pier starts is not mounted, and
  the Pier spawned for it stops.
- **Sign-in**: when the local tab lands on `/login`, the shell runs the
  command with `serve` swapped for `login` (`pier login`'s one-time link,
  the same `PIER_HOME`) and loads the link, at most once per 30s per tab: the
  terminal on Pier's own machine is already its door (`src/web/auth.ts`), so
  no password and no auth change; a sign-out signs straight back in. A
  command not ending in `serve` gets no link; the login page asks as in a
  browser. `pier login` too is killed after 20s with its error shown.
- **Restart**: the first open tab is shown, as for any instance; a local one
  is shown once its Pier answers unless a tab was picked meanwhile, and
  another local tab never takes over.
- **Quit** (Cmd+Q, the window's close): when a spawned Pier's open tab has a
  session mid-turn or with a run in flight (`/api/sessions`, read by its own
  page; one that cannot tell counts none), the first quit shows the count on
  the tab bar and a second within 8s quits; so does a second after the count
  itself failed. Then each spawned process group gets SIGTERM, and SIGKILL after
  10s, all in parallel. A Dock Quit cannot be held, so it skips the warning, not the stop.

## Bridge (`src/web/ui/shell.ts`)

The web UI detects the shell (`window.__TAURI__`) and talks to it through
one ~30-line module; in a browser every call is a no-op.

- **Badge**: where `notifications.ts` calls `navigator.setAppBadge(count)`,
  the bridge sends `count` to the shell instead; the shell shows it on the
  instance's tab and sums every instance onto the Dock / taskbar badge.
- **Notifications**: Web Push cannot reach a webview, so the push pipeline
  (`push.ts`: settle window, silent-reply and seen checks, "the browser that
  spoke" targeting) gains a second delivery: besides the push, `deliver`
  emits `{type: "notification", title, body, url, tag}` on the workspace
  stream, and `GET /api/events` forwards it only to the web session the push
  targets (every one for the "every device" case). The UI in a browser
  ignores the event (push already covers it); in the shell the bridge hands
  it to the native notification, titled `<instance name> · <title>` by the
  shell so it says which instance spoke, with the system's default sound
  (`NSUserNotificationDefaultSoundName`; the freedesktop `message-new-instant`
  elsewhere) unless the same session's sounded within 30s. Body is the same
  `preview(reply.text)` the push sends — the topic is in it. Click: the shell focuses the window and
  that instance, reopening its tab if it was closed since, and sets the page's hash from `url` itself; an instance page
  holds no event permission, so no page can hear the tab bar's or another's.
- **Visibility**: a hidden instance's webview must read
  `document.hidden === true`, or the UI acks every turn as seen
  (`main.ts:315`) and nothing is ever unread. The shell hides, not merely
  covers, inactive webviews; verified on both platforms before anything else
  is built.

## Keyboard

`Cmd+1…9` (Ctrl on Linux) switch to the Nth open tab, `Cmd+Shift+[` / `]`
previous / next open tab, `Cmd+N` add an instance, `Cmd+R` (and `F5` off macOS) reload
the shown instance (a page whose assets were rebuilt under it recovers only so), `Cmd+W`
closes the shown tab, and on the last tab the window, as Safari (the tab stays open for the
next launch); macOS's default Close Window loses `Cmd+W` to it. They are the
Instances menu's accelerators: in the menu bar on macOS, in the hidden menu bar elsewhere,
which still fires them. The tab bar is the only native surface with focus;
everything else is the web UI's own keyboard.

## Out of scope (v1)

- iOS, Windows.
- Release, signing, updater: `just native` builds a local bundle; nothing is
  published until the experiment is judged.
- Installing instances, or starting one anywhere but on this machine with the app.
- Any native page replicating a web view.

## Repository

- `native/` beside `src/`: `src-tauri/` (Rust) and the tab bar page (TS,
  built by `native/vite.config.ts`); `just native-dev`, `just native`.
- Budget line: `native/` ≤ 1190 non-blank lines (Rust + TS), the lines past
  830 the user's follow-ups (the instance's name on notifications, the origin
  guard's wait for the title, the data store removal's retry), the lines past
  845 Reload's tab menu, `F5` and Linux's hung-process replacement, the lines
  past 880 tabs opened and closed on demand, the `+` menu and the webviews
  built off the main thread, the lines past 950 `Cmd+W` closing a tab, the lines past 965 the local
  instance (finding its command, starting it, signing in, stopping it on quit); the server-side
  change is the `notification` workspace event alone (~20 lines in `push.ts`
  and `server.ts`), the UI change `shell.ts` and two call sites.
- New toolchain: Rust + cargo lockfile, reviewed on upgrade like
  `package-lock.json`; `@tauri-apps/api` the one new npm dependency, dev-only.
