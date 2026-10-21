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
  bundled browser engine; the Rust side is instance bookkeeping, the rail,
  the badge and the notification call, nothing about chat.
- **Instance** = `{name, url}` in the shell's own store
  (`~/.config/pier-client/instances.json`). Auth is the instance's own: each
  webview keeps a persistent cookie jar of its own, and the operator signs in
  with the password, a passkey or a `pier login` link as in a browser. The
  shell holds no credential and opens no HTTP connection of its own.
- **Rail**: a left column of instances (icon in the instance's accent, name,
  unread count); click switches the visible webview, the others stay mounted
  so SSE streams and composer drafts survive a switch. Add = paste a URL or a
  `pier login` link (sets url and signs in at once); remove, rename, reorder.
  `name` defaults to the instance's `PIER_TITLE`, read from the page title.

## Bridge (`src/web/ui/shell.ts`)

The web UI detects the shell (`window.__TAURI__`) and talks to it through
one ~30-line module; in a browser every call is a no-op.

- **Badge**: where `notifications.ts` calls `navigator.setAppBadge(count)`,
  the bridge sends `count` to the shell instead; the shell shows it on the
  rail row and sums every instance onto the Dock / taskbar badge.
- **Notifications**: Web Push cannot reach a webview, so the push pipeline
  (`push.ts`: settle window, silent-reply and seen checks, "the browser that
  spoke" targeting) gains a second delivery: besides the push, `deliver`
  emits `{type: "notification", title, body, url, tag}` on the workspace
  stream, and `GET /api/events` forwards it only to the web session the push
  targets (every one for the "every device" case). The UI in a browser
  ignores the event (push already covers it); in the shell the bridge hands
  it to the native notification. Body is the same `preview(reply.text)` the
  push sends — the topic is in it. Click: the shell focuses the window and
  that instance, and the UI navigates to `url`.
- **Visibility**: a hidden instance's webview must read
  `document.hidden === true`, or the UI acks every turn as seen
  (`main.ts:315`) and nothing is ever unread. The shell hides, not merely
  covers, inactive webviews; verified on both platforms before anything else
  is built.

## Keyboard

`Cmd+1…9` (Ctrl on Linux) switch to the Nth instance, `Cmd+Shift+[` / `]`
previous / next, `Cmd+N` add an instance. The rail is the only native
surface with focus; everything else is the web UI's own keyboard.

## Out of scope (v1)

- iOS, Windows.
- Release, signing, updater: `just native` builds a local bundle; nothing is
  published until the experiment is judged.
- Starting, stopping or installing instances; the shell talks HTTP only.
- Any native page replicating a web view.

## Repository

- `native/` beside `src/`: `src-tauri/` (Rust) and the rail page (TS, built
  by the same Vite config as a second entry); `just native-dev`, `just native`.
- Budget line: `native/` ≤ 600 non-blank lines (Rust + TS); the server-side
  change is the `notification` workspace event alone (~20 lines in `push.ts`
  and `server.ts`), the UI change `shell.ts` and two call sites.
- New toolchain: Rust + cargo lockfile, reviewed on upgrade like
  `package-lock.json`; `@tauri-apps/api` the one new npm dependency, dev-only.
