# Native client (design)

A desktop shell around the web workbench, for people who run more than one
Pier: one window, every instance, one unread count, native notifications.
macOS first, Linux the same code. The web UI stays the only chat and Console
implementation ([03](03-web-workbench.md)); the shell adds only what a
browser tab cannot. An experiment: it earns a release when it is used daily
for a few weeks, and is deleted whole if it is not.

## Shape

- **Tauri 2** (`native/`): a Rust shell over the system webview (WebKit on
  both platforms), one webview per instance, each loading `<url>/app/`. No
  bundled browser engine; the Rust side is instance bookkeeping, the tab
  bar, the badge and the notification call, nothing about chat.
- **Instance** = `{name, url}` in the shell's own store
  (`~/.config/pier-client/instances.json`; a debug build keeps its own list
  in `pier-client-dev/`, as its cookie stores are not the bundle's). Auth is
  the instance's own: each webview keeps a persistent cookie jar of its own, and the operator signs in
  with the password, a passkey or a `pier login` link as in a browser. The
  shell holds no credential and opens no HTTP connection of its own.
- **Tab bar**: one 32px row across the top, a tab per instance (dot in the
  instance's accent, name, red unread count), then `+`; the instance's page
  fills the window below. A tab is a 24px rounded pill, 180px wide until the
  window is too narrow, its name truncated with an ellipsis; the shown one is
  raised on `Canvas`, its `×` always visible, the others' only on hover. On
  macOS the row's centre line is the traffic lights'. Click switches the visible webview, the others stay
  mounted so SSE streams and composer drafts survive a switch. Add = paste a
  URL or a `pier login` link into the field `+` opens (sets url and signs in
  at once); `×` then `Remove` removes it with its cookie jar and storage
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
  shell so it says which instance spoke. Body is the same
  `preview(reply.text)` the push sends — the topic is in it. Click: the shell focuses the window and
  that instance and sets the page's hash from `url` itself; an instance page
  holds no event permission, so no page can hear the tab bar's or another's.
- **Visibility**: a hidden instance's webview must read
  `document.hidden === true`, or the UI acks every turn as seen
  (`main.ts:315`) and nothing is ever unread. The shell hides, not merely
  covers, inactive webviews; verified on both platforms before anything else
  is built.

## Keyboard

`Cmd+1…9` (Ctrl on Linux) switch to the Nth instance, `Cmd+Shift+[` / `]`
previous / next, `Cmd+N` add an instance, `Cmd+R` (and `F5` off macOS) reload
the shown instance (a page whose assets were rebuilt under it recovers only so). They are the
Instances menu's accelerators: in the menu bar on macOS, in the hidden menu bar elsewhere,
which still fires them. The tab bar is the only native surface with focus;
everything else is the web UI's own keyboard.

## Out of scope (v1)

- iOS, Windows.
- Release, signing, updater: `just native` builds a local bundle; nothing is
  published until the experiment is judged.
- Starting, stopping or installing instances; the shell talks HTTP only.
- Any native page replicating a web view.

## Repository

- `native/` beside `src/`: `src-tauri/` (Rust) and the tab bar page (TS,
  built by `native/vite.config.ts`); `just native-dev`, `just native`.
- Budget line: `native/` ≤ 880 non-blank lines (Rust + TS), the lines past
  830 the user's follow-ups (the instance's name on notifications, the origin
  guard's wait for the title, the data store removal's retry), the lines past
  845 Reload's tab menu, `F5` and Linux's hung-process replacement; the server-side
  change is the `notification` workspace event alone (~20 lines in `push.ts`
  and `server.ts`), the UI change `shell.ts` and two call sites.
- New toolchain: Rust + cargo lockfile, reviewed on upgrade like
  `package-lock.json`; `@tauri-apps/api` the one new npm dependency, dev-only.
