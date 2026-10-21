//! Pier's native client: one frameless window, a tab per open Pier instance over one webview each.

mod store;

use std::{
    collections::{HashMap, HashSet},
    fmt::Display,
    fs,
    future::Future,
    hash::{DefaultHasher, Hash, Hasher},
    io,
    path::PathBuf,
    process::Command,
    sync::{mpsc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use store::Instance;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    webview::{NewWindowResponse, PageLoadEvent},
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl, Window,
    WindowEvent,
};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

const WINDOW: &str = "main";
const TABS: &str = "tabs";
/// Safari's tab bar height, so the 28px tabs clear the window's top edge. macOS keeps its traffic
/// lights centred on a 16pt line, ~3px above this row's centre; tauri's WindowBuilder cannot move them.
const TABS_HEIGHT: f64 = 38.0;
const INSTANCES: &str = "instances";

type Res<T = ()> = Result<T, String>;

struct Shell {
    /// `pier-client/` in the platform config dir, `pier-client-dev/` for a debug build:
    /// the list and every instance's data, whose cookie stores the two builds do not share.
    dir: PathBuf,
    state: Mutex<Live>,
}

#[derive(Default)]
struct Live {
    instances: Vec<Instance>,
    unread: HashMap<String, u32>,
    accent: HashMap<String, String>,
    active: Option<String>,
    /// Instances whose capability is added: Tauri appends a repeated one rather than replacing it.
    granted: HashSet<String>,
    /// What went wrong before the tab bar could show it; `list` hands it over.
    startup_error: Option<String>,
    badge_logged: bool,
}

impl Shell {
    fn lock(&self) -> MutexGuard<'_, Live> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self) -> PathBuf {
        self.dir.join("instances.json")
    }

    fn data_dir(&self, id: &str) -> PathBuf {
        self.dir.join("webviews").join(id)
    }
}

fn text(e: impl Display) -> String {
    e.to_string()
}

fn position(all: &[Instance], id: &str) -> Res<usize> {
    all.iter().position(|i| i.id == id).ok_or_else(|| format!("no instance {id}"))
}

/// The open instances, in the list's order: the tabs.
fn tabs(all: &[Instance]) -> Vec<&Instance> {
    all.iter().filter(|i| !i.closed).collect()
}

/// Logs `message` and shows it on the tab bar: a failure is never only a log line.
fn report(app: &AppHandle, message: impl Display) {
    eprintln!("pier-client: {message}");
    if let Err(e) = app.emit_to(TABS, "error", message.to_string()) {
        eprintln!("pier-client: the tab bar missed that: {e}");
    }
}

/// An instance's command failing shows on the tab bar too, not only in its page's console.
fn surfaced(app: &AppHandle, result: Res) -> Res {
    if let Err(e) = &result {
        report(app, e);
    }
    result
}

/// Pushes the tabs to the tab bar and their unread sum to the Dock / taskbar badge.
fn publish(app: &AppHandle, live: &mut Live) {
    let rows: Vec<Value> = tabs(&live.instances)
        .into_iter()
        .map(|i| {
            let (unread, accent) = (live.unread.get(&i.id).copied().unwrap_or(0), live.accent.get(&i.id));
            json!({ "id": i.id, "name": i.name, "url": i.url, "unread": unread, "accent": accent,
                    "active": live.active.as_ref() == Some(&i.id) })
        })
        .collect();
    if let Err(e) = app.emit_to(TABS, "state", &rows) {
        eprintln!("pier-client: the tab bar missed a state: {e}");
    }
    // Saturating: each count is a page's to choose, and an overflow panics a debug build.
    let total = live.unread.values().fold(0u32, |sum, &n| sum.saturating_add(n));
    let badge = app.get_window(WINDOW).map(|w| w.set_badge_count((total > 0).then_some(total.into())));
    if let Some(Err(e)) = badge {
        if !live.badge_logged {
            live.badge_logged = true;
            eprintln!("pier-client: no Dock/taskbar badge on this platform: {e}");
        }
    }
}

/// Applies `change` to a copy of the list and commits it only once it is on disk.
fn edit(app: &AppHandle, shell: &Shell, change: impl FnOnce(&mut Vec<Instance>) -> Res) -> Res {
    let mut live = shell.lock();
    let mut next = live.instances.clone();
    change(&mut next)?;
    if next != live.instances {
        store::save(&shell.store(), &next)?;
        live.instances = next;
    }
    publish(app, &mut live);
    Ok(())
}

/// The tab bar across the top at a fixed height, every instance filling the rest; on Linux
/// these calls are no-ops and GTK lays out the window's box, where `dock` fixes the bar.
fn layout(window: &Window) -> tauri::Result<()> {
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    for webview in window.webviews() {
        let (y, height) =
            if webview.label() == TABS { (0.0, TABS_HEIGHT) } else { (TABS_HEIGHT, size.height - TABS_HEIGHT) };
        webview.set_position(LogicalPosition::new(0.0, y))?;
        webview.set_size(LogicalSize::new(size.width, height))?;
    }
    Ok(())
}

/// GTK packs each child webview into the window's vertical box, expanding, in creation order:
/// the tab bar, created first, is held at its height and every instance below shares the rest.
#[cfg(target_os = "linux")]
fn dock(webview: &Webview) -> tauri::Result<()> {
    use gtk::prelude::*;
    let (app, tabs) = (webview.app_handle().clone(), webview.label() == TABS);
    webview.with_webview(move |platform| {
        let widget = platform.inner().upcast::<gtk::Widget>();
        resize_edges(&widget);
        if !tabs {
            return;
        }
        let Some(vbox) = widget.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
            return report(&app, "layout: the tab bar is not in the window's box");
        };
        vbox.set_child_packing(&widget, false, true, 0, gtk::PackType::Start);
        widget.set_size_request(-1, TABS_HEIGHT as i32);
        // GTK fires only a drawable item's accelerator: each item of the hidden menu bar says it can.
        let mut items: Vec<gtk::Widget> = vbox.children().into_iter().filter(|c| c.is::<gtk::MenuBar>()).collect();
        while let Some(item) = items.pop() {
            item.connect_can_activate_accel(|_, _| true);
            if let Some(shell) = item.downcast_ref::<gtk::Container>() {
                items.extend(shell.children());
            }
            if let Some(menu) = item.downcast_ref::<gtk::MenuItem>().and_then(|i| i.submenu()) {
                items.push(menu);
            }
        }
    })
}

/// Tauri arms an undecorated window's resize edges on its content webview only, and tao on
/// the window, which the webviews cover: each child webview takes the edges it lies on.
#[cfg(target_os = "linux")]
fn resize_edges(widget: &gtk::Widget) {
    use gtk::{gdk, gdk::WindowEdge::*, glib::Propagation, prelude::*};
    fn edge(widget: &gtk::Widget, (x, y): (f64, f64)) -> Option<(gdk::Window, gdk::WindowEdge, &'static str)> {
        let full = gdk::WindowState::MAXIMIZED | gdk::WindowState::FULLSCREEN;
        let frame = widget.toplevel()?.window().filter(|f| !f.state().intersects(full))?;
        let ((left, top), inset) = (frame.position(), f64::from(5 * frame.scale_factor()));
        let (x, y) = (x - f64::from(left), y - f64::from(top));
        let (w, h) = (f64::from(frame.width()), f64::from(frame.height()));
        let (edge, cursor) = match (y < inset, y >= h - inset, x < inset, x >= w - inset) {
            (true, _, true, _) => (NorthWest, "nw-resize"),
            (true, _, _, true) => (NorthEast, "ne-resize"),
            (true, ..) => (North, "n-resize"),
            (_, true, true, _) => (SouthWest, "sw-resize"),
            (_, true, _, true) => (SouthEast, "se-resize"),
            (_, true, ..) => (South, "s-resize"),
            (_, _, true, _) => (West, "w-resize"),
            (_, _, _, true) => (East, "e-resize"),
            _ => return None,
        };
        Some((frame, edge, cursor))
    }
    widget.add_events(gdk::EventMask::POINTER_MOTION_MASK | gdk::EventMask::BUTTON_PRESS_MASK);
    // WebKit sets the cursor only when its own changes, so leaving an edge resets ours here.
    let armed = std::cell::Cell::new(false);
    widget.connect_motion_notify_event(move |widget, event| {
        let Some(own) = widget.window() else { return Propagation::Proceed };
        let cursor = edge(widget, event.root()).and_then(|(_, _, name)| gdk::Cursor::from_name(&own.display(), name));
        if armed.replace(cursor.is_some()) || cursor.is_some() {
            own.set_cursor(cursor.as_ref());
        }
        cursor.map_or(Propagation::Proceed, |_| Propagation::Stop)
    });
    widget.connect_button_press_event(|widget, event| match edge(widget, event.root()) {
        Some((frame, edge, _)) if event.button() == 1 => {
            let (x, y) = event.root();
            frame.begin_resize_drag(edge, 1, x as i32, y as i32, event.time());
            Propagation::Stop
        }
        _ => Propagation::Proceed,
    });
}

fn open_external(url: &Url) -> io::Result<()> {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err(io::Error::other("not a web link"));
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let mut child = Command::new(opener).arg(url.as_str()).spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// A page the instance does not keep (`Instance::keeps`) goes to the system browser.
fn to_browser(app: &AppHandle, url: &Url) {
    if let Err(e) = open_external(url) {
        report(app, format!("opening {url}: {e}"));
    }
}

/// Adds an instance's webview, hidden, over a persistent data store of its own. Its
/// commands are granted to its own origin only, so a foreign page in it has no IPC.
fn mount(app: &AppHandle, shell: &Shell, instance: &Instance, first: Url) -> Res {
    let window = app.get_window(WINDOW).ok_or("the window is gone")?;
    if !shell.lock().granted.contains(&instance.id) {
        let capability = ["allow-set-badge", "allow-notify", "allow-page-title"].into_iter().fold(
            CapabilityBuilder::new(format!("instance-{}", instance.id))
                .webview(&instance.id)
                .remote(instance.url.clone())
                .local(false),
            CapabilityBuilder::permission,
        );
        app.add_capability(capability).map_err(text)?;
        shell.lock().granted.insert(instance.id.clone());
    }
    let (handle, own) = (app.clone(), instance.clone());
    let keep = move |url: &Url| {
        own.keeps(url) || {
            to_browser(&handle, url);
            false
        }
    };
    let (opener, id) = (app.clone(), instance.id.clone());
    let builder = WebviewBuilder::new(&instance.id, WebviewUrl::External(first))
        .data_directory(shell.data_dir(&instance.id))
        .disable_drag_drop_handler()
        .on_navigation(keep.clone())
        // A link the page opens in a new window: its own page takes the tab, as a click would.
        .on_new_window(move |url, _| {
            if !keep(&url) {
                return NewWindowResponse::Deny;
            }
            let (handle, id) = (opener.clone(), id.clone());
            let navigated = opener.run_on_main_thread(move || {
                let webview = handle.get_webview(&id).ok_or_else(|| format!("{id} has no webview"));
                if let Err(e) = webview.and_then(|w| w.navigate(url).map_err(text)) {
                    report(&handle, format!("opening a link: {e}"));
                }
            });
            if let Err(e) = navigated {
                report(&opener, format!("opening a link: {e}"));
            }
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store::store_key(&instance.id));
    let at = LogicalPosition::new(0.0, TABS_HEIGHT);
    let webview = window.add_child(builder, at, LogicalSize::new(1.0, 1.0)).map_err(text)?;
    #[cfg(target_os = "linux")]
    dock(&webview).map_err(text)?;
    webview.hide().map_err(text)?;
    layout(&window).map_err(text)
}

/// Reloads an instance's page from the shell, not its script, so a hung page reloads too; a
/// page whose assets were rebuilt under it recovers only by loading again.
fn reload(app: &AppHandle, id: &str) -> Res {
    let webview = app.get_webview(id).ok_or_else(|| format!("{id} has no webview"))?;
    // WebKit hands a reload to the page's process, which a hung script never answers, and flags
    // it unresponsive only seconds later: Linux always reloads in a new process.
    #[cfg(target_os = "linux")]
    let reloaded = webview.with_webview(|platform| {
        use webkit2gtk::WebViewExt;
        let page = platform.inner();
        page.terminate_web_process();
        page.reload();
    });
    #[cfg(not(target_os = "linux"))]
    let reloaded = webview.reload();
    reloaded.map_err(text)
}

/// Shows one instance and hides the rest, so an inactive page reads `document.hidden`.
fn show_instance(app: &AppHandle, shell: &Shell, id: &str) -> Res {
    let mut live = shell.lock();
    position(&live.instances, id)?;
    let target = app.get_webview(id).ok_or_else(|| format!("{id} has no webview"))?;
    target.show().map_err(text)?;
    for other in live.instances.iter().filter(|i| i.id != id) {
        if let Some(webview) = app.get_webview(&other.id) {
            webview.hide().map_err(text)?;
        }
    }
    target.set_focus().map_err(text)?;
    live.active = Some(id.to_owned());
    publish(app, &mut live);
    Ok(())
}

/// Shows the tab `pick` names from the active one's index and the count; none when no tab is open.
fn show_at(app: &AppHandle, shell: &Shell, pick: impl FnOnce(Option<usize>, usize) -> usize) -> Res {
    let id = {
        let live = shell.lock();
        let tabs = tabs(&live.instances);
        let active = live.active.as_deref().and_then(|a| tabs.iter().position(|i| i.id == a));
        (!tabs.is_empty()).then(|| pick(active, tabs.len())).and_then(|n| tabs.get(n)).map(|i| i.id.clone())
    };
    id.map_or(Ok(()), |id| show_instance(app, shell, &id))
}

/// The tab bar is ready: it gets the tabs, and anything that failed before it could listen.
#[tauri::command]
fn list(app: AppHandle, shell: State<'_, Shell>) -> Res {
    let mut live = shell.lock();
    publish(&app, &mut live);
    live.startup_error.take().map_or(Ok(()), Err)
}

enum Probed {
    Title(String),
    Loaded,
    Left(Url),
}

/// The probe's verdict from its events. WebKit reports the title after the load finishes,
/// so a finished load waits up to `grace` for it.
fn verdict(rx: &mpsc::Receiver<Probed>, wait: Duration, grace: Duration) -> Option<String> {
    let (mut deadline, mut title, mut loaded) = (Instant::now() + wait, String::new(), false);
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Probed::Title(t)) if t == "Pier" => return None,
            Ok(Probed::Title(t)) => title = t,
            Ok(Probed::Loaded) => (loaded, deadline) = (true, deadline.min(Instant::now() + grace)),
            Ok(Probed::Left(url)) => return Some(format!("it redirects to {url}")),
            Err(_) if !loaded => return Some(format!("no answer within {}s", wait.as_secs())),
            Err(_) if title.is_empty() => return Some("its /login has no title".to_owned()),
            Err(_) => return Some(format!("its /login is titled \"{title}\"")),
        }
    }
}

/// Why `origin` does not look like Pier, if it does not: every Pier serves `/login`, signed
/// out, as a page titled "Pier". Loaded in a hidden throwaway webview with no cookie jar
/// and no IPC, so the shell still opens no connection of its own.
async fn probe(app: &AppHandle, instance: &Instance) -> Res<Option<String>> {
    let window = app.get_window(WINDOW).ok_or("the window is gone")?;
    let login = Url::parse(&instance.url).and_then(|u| u.join("/login")).map_err(text)?;
    let (tx, rx) = mpsc::channel();
    let (titled, loaded, own) = (tx.clone(), tx.clone(), instance.clone());
    let builder = WebviewBuilder::new(format!("probe-{}", instance.id), WebviewUrl::External(login))
        .incognito(true)
        .on_navigation(move |url| {
            own.keeps(url) || {
                drop(tx.send(Probed::Left(url.clone())));
                false
            }
        })
        .on_document_title_changed(move |_, title| drop(titled.send(Probed::Title(title))))
        .on_page_load(move |_, load| {
            if load.event() == PageLoadEvent::Finished {
                drop(loaded.send(Probed::Loaded));
            }
        });
    let webview = window.add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0));
    let webview = webview.map_err(text)?;
    webview.hide().map_err(text)?;
    let (wait, grace) = (Duration::from_secs(10), Duration::from_secs(2));
    let verdict = tauri::async_runtime::spawn_blocking(move || verdict(&rx, wait, grace)).await.map_err(text);
    webview.close().map_err(text)?;
    verdict
}

/// The warning when the input does not look like Pier, unless `force`: added only then.
/// Async: building a webview from a sync command, which runs on the main thread, can deadlock.
#[tauri::command]
async fn add(app: AppHandle, shell: State<'_, Shell>, input: String, force: bool) -> Res<Option<String>> {
    let (instance, first) = Instance::parse(&input)?;
    if !force {
        if let Some(why) = probe(&app, &instance).await? {
            return Ok(Some(format!("Does not look like Pier ({why}): Enter again to add it anyway")));
        }
    }
    edit(&app, &shell, |all| {
        all.push(instance.clone());
        Ok(())
    })?;
    mount(&app, &shell, &instance, first)?;
    show_instance(&app, &shell, &instance.id).map(|()| None)
}

/// Opens a listed instance's tab, or shows its open one; `hash`, if any, is the page it shows.
fn open(app: &AppHandle, shell: &Shell, id: &str, hash: Option<&str>) -> Res {
    if let Some(webview) = app.get_webview(id) {
        show_instance(app, shell, id)?;
        // Set from here, not sent as an event: an instance page holds no event
        // permission, so no page can hear another's.
        return hash
            .map_or(Ok(()), |hash| webview.eval(format!("location.hash = {}", Value::from(hash))).map_err(text));
    }
    let instance = shell.lock().instances.iter().find(|i| i.id == id).cloned().ok_or(format!("no instance {id}"))?;
    let mut first = instance.app_url()?;
    first.set_fragment(hash);
    mount(app, shell, &instance, first)?;
    let saved = edit(app, shell, |all| {
        let at = position(all, id)?;
        all[at].closed = false;
        Ok(())
    });
    // A list that will not save keeps it closed, so its webview goes too.
    if let Err(e) = saved {
        let closed = app.get_webview(id).ok_or_else(|| format!("{id} has no webview"));
        return Err(match closed.and_then(|w| w.close().map_err(text)) {
            Ok(()) => e,
            Err(c) => format!("{e}; closing it: {c}"),
        });
    }
    show_instance(app, shell, id)
}

/// Closes an instance's webview, then applies `change` to it in the list; a webview that will
/// not close changes nothing. A list that will not save still loses the tab, closed in memory
/// only, since its webview is gone: a restart reopens it.
fn take_down(app: &AppHandle, shell: &Shell, id: &str, change: impl FnOnce(&mut Vec<Instance>, usize)) -> Res {
    let at = tabs(&shell.lock().instances).iter().position(|i| i.id == id);
    if let Some(webview) = app.get_webview(id) {
        webview.close().map_err(text)?;
    }
    let saved = edit(app, shell, |all| {
        let at = position(all, id)?;
        change(all, at);
        Ok(())
    });
    let was_active = {
        let mut live = shell.lock();
        if saved.is_err() {
            live.instances.iter_mut().filter(|i| i.id == id).for_each(|i| i.closed = true);
        }
        live.unread.remove(id);
        live.accent.remove(id);
        publish(app, &mut live);
        live.active.take_if(|active| active == id).is_some()
    };
    if let (Some(at), true) = (at, was_active) {
        if let Err(e) = show_at(app, shell, |_, len| at.min(len - 1)) {
            report(app, e);
        }
    }
    saved
}

/// Its data stays, so reopening it from `+` finds it signed in. Async, as `add`.
#[tauri::command]
async fn close(app: AppHandle, shell: State<'_, Shell>, id: String) -> Res {
    take_down(&app, &shell, &id, |all, at| all[at].closed = true)
}

/// Its data goes with it: the cookie jar, so a re-added instance signs in afresh.
async fn remove(app: &AppHandle, id: &str) -> Res {
    take_down(app, &app.state::<Shell>(), id, |all, at| drop(all.remove(at)))?;
    // Last, so data that will not go leaves no blank window behind.
    remove_data(app, id).await.map_err(|e| format!("removing the instance's data: {e}"))
}

/// On macOS its WebKit data store, retried: WebKit refuses one a just-closed webview still holds.
async fn remove_data(app: &AppHandle, id: &str) -> Res {
    #[cfg(target_os = "macos")]
    for retry in 1.. {
        match app.remove_data_store(store::store_key(id)).await {
            Ok(()) => break,
            Err(e) if retry == 8 => return Err(text(e)),
            Err(_) => {
                let pause = move || std::thread::sleep(Duration::from_millis(100 * retry));
                tauri::async_runtime::spawn_blocking(pause).await.map_err(text)?;
            }
        }
    }
    let gone = fs::remove_dir_all(app.state::<Shell>().data_dir(id));
    gone.or_else(|e| (e.kind() == io::ErrorKind::NotFound).then_some(()).ok_or_else(|| text(e)))
}

/// An empty name hands naming back to the page title.
#[tauri::command]
fn rename(app: AppHandle, shell: State<'_, Shell>, id: String, name: String) -> Res {
    edit(&app, &shell, |all| {
        let at = position(all, &id)?;
        let instance = &mut all[at];
        let name = name.trim();
        instance.named = !name.is_empty();
        instance.name = if instance.named { name.to_owned() } else { store::host(&instance.url) };
        Ok(())
    })
}

/// Moves `id` to where the tab it was dropped `onto` stands in the list, closed instances included.
#[tauri::command]
fn reorder(app: AppHandle, shell: State<'_, Shell>, id: String, onto: String) -> Res {
    edit(&app, &shell, |all| {
        let to = position(all, &onto)?;
        let instance = all.remove(position(all, &id)?);
        all.insert(to, instance);
        Ok(())
    })
}

#[tauri::command]
fn select(app: AppHandle, shell: State<'_, Shell>, id: String) -> Res {
    show_instance(&app, &shell, &id)
}

#[tauri::command]
fn set_badge(app: AppHandle, shell: State<'_, Shell>, webview: Webview, count: u32) -> Res {
    let mut live = shell.lock();
    let known = position(&live.instances, webview.label()).map(|_| {
        live.unread.insert(webview.label().to_owned(), count);
        publish(&app, &mut live);
    });
    drop(live);
    surfaced(&app, known)
}

/// Titled `<instance> · <title>`: with several instances, the push's own title does not say which.
#[tauri::command]
fn notify(app: AppHandle, webview: Webview, title: String, body: String, url: String, tag: String) -> Res {
    if !url.starts_with("/app/") {
        return surfaced(&app, Err(format!("not a workbench path: {url}")));
    }
    // As Web Push's `tag`: a session's later notification replaces its earlier
    // one, where the platform can close it (Linux; macOS stacks regardless).
    let live = app.state::<Shell>().lock().instances.iter().find(|i| i.id == webview.label()).map(|i| i.name.clone());
    let title = live.map_or(title.clone(), |name| format!("{name} · {title}"));
    let mut hasher = DefaultHasher::new();
    (webview.label(), &tag).hash(&mut hasher);
    let id = hasher.finish() as i32;
    let notifications = app.notification();
    let shown = notifications
        .remove_active(vec![id])
        .and_then(|()| {
            notifications
                .builder()
                .id(id)
                .title(title)
                .body(body)
                .extra("instance", webview.label())
                .extra("url", url)
                .show()
        })
        .map_err(|e| format!("notification: {e}"));
    surfaced(&app, shown)
}

/// PIER_TITLE names an instance the user has not named; `accent` (`#rrggbb`) paints its dot.
#[tauri::command]
fn page_title(app: AppHandle, shell: State<'_, Shell>, webview: Webview, title: String, accent: Option<String>) -> Res {
    let id = webview.label();
    let result = (|| {
        if let Some(accent) = accent {
            let hex = accent.strip_prefix('#').filter(|h| h.len() == 6);
            if !hex.is_some_and(|h| h.bytes().all(|b| b.is_ascii_hexdigit())) {
                return Err(format!("not an accent: {accent}"));
            }
            shell.lock().accent.insert(id.to_owned(), accent);
        }
        edit(&app, &shell, |all| {
            let at = position(all, id)?;
            let (instance, title) = (&mut all[at], title.trim());
            if !instance.named && !title.is_empty() {
                instance.name = title.to_owned();
            }
            Ok(())
        })
    })();
    surfaced(&app, result)
}

fn instance_field<'a>(performed: &'a ActionPerformed, key: &str) -> Option<&'a str> {
    performed.notification()?.extra().get(key)?.as_str()
}

/// A click on a notification brings the window, then the instance, opening its tab if
/// it was closed since, then the page at `url`.
fn on_tap(app: &AppHandle, performed: &ActionPerformed) {
    if performed.action_id() != "tap" {
        return;
    }
    let (Some(id), Some(url)) = (instance_field(performed, "instance"), instance_field(performed, "url")) else {
        return report(app, "a notification click arrived without its instance");
    };
    let (app, id, hash) = (app.clone(), id.to_owned(), url.split_once('#').map_or("", |(_, h)| h).to_owned());
    detach(&app.clone(), async move {
        app.get_window(WINDOW)
            .ok_or_else(|| "the window is gone".to_owned())
            .and_then(|w| w.unminimize().and_then(|()| w.show()).and_then(|()| w.set_focus()).map_err(text))
            .and_then(|()| open(&app, &app.state::<Shell>(), &id, Some(&hash)))
            .map_err(|e| format!("opening a notification: {e}"))
    });
}

/// Off the calling thread, which may be the main one: a webview built or a data store
/// removed from it can deadlock.
fn detach(app: &AppHandle, work: impl Future<Output = Res> + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = work.await {
            report(&app, e);
        }
    });
}

/// `+`'s menu: every listed instance, the open ones checked, to open; then Add, and Remove.
fn saved(app: &AppHandle, all: &[Instance]) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: String, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let menu = Menu::new(app)?;
    let remove = Submenu::new(app, "Remove and Delete Data", !all.is_empty())?;
    for i in all {
        menu.append(&CheckMenuItem::with_id(app, format!("open:{}", i.id), &i.name, true, !i.closed, None::<&str>)?)?;
        remove.append(&item(format!("remove:{}", i.id), &i.name)?)?;
    }
    if !all.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append_items(&[&item("add".into(), "Add Instance…")?, &remove])?;
    Ok(menu)
}

/// The tab bar's menus, dropped at `x`, `y` in the bar: `+`'s for `+`, the menu button's,
/// which is Instances, for `⋯`, else the tab's own whose id `menu` is.
#[tauri::command]
fn popup(app: AppHandle, shell: State<'_, Shell>, window: Window, menu: String, x: f64, y: f64) -> Res {
    let at = LogicalPosition::new(x, y);
    if menu == "+" {
        // Built before the popup, which holds the thread: the list's lock is not held across it.
        let saved = saved(&app, &shell.lock().instances).map_err(text)?;
        return window.popup_menu_at(&saved, at).map_err(text);
    }
    if menu != "⋯" {
        let reload = MenuItem::with_id(&app, format!("reload:{menu}"), "Reload", true, None::<&str>).map_err(text)?;
        return window.popup_menu_at(&Menu::with_items(&app, &[&reload]).map_err(text)?, at).map_err(text);
    }
    let menu = app.menu().and_then(|m| m.get(INSTANCES)).and_then(|i| i.as_submenu().cloned());
    window.popup_menu_at(&menu.ok_or("no Instances menu")?, at).map_err(text)
}

/// Accelerators on the app menu, so they fire while an instance's page has focus. Only macOS
/// shows a menu bar; elsewhere it is hidden and the tab bar's menu button pops up Instances.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = if cfg!(target_os = "macos") { Menu::default(app)? } else { Menu::new(app)? };
    let item = |id: String, label: String, keys: String| MenuItem::with_id(app, id, label, true, Some(keys));
    let instances = Submenu::with_id_and_items(
        app,
        INSTANCES,
        "Instances",
        true,
        &[
            &item("add".into(), "Add Instance…".into(), "CmdOrCtrl+N".into())?,
            &item("prev".into(), "Previous Instance".into(), "CmdOrCtrl+Shift+[".into())?,
            &item("next".into(), "Next Instance".into(), "CmdOrCtrl+Shift+]".into())?,
            &item("reload".into(), "Reload Instance".into(), "CmdOrCtrl+R".into())?,
        ],
    )?;
    for n in 1..=9 {
        instances.append(&item(format!("nth-{n}"), format!("Instance {n}"), format!("CmdOrCtrl+{n}"))?)?;
    }
    menu.append(&instances)?;
    // An item holds one accelerator: F5's is a second Reload, in a submenu `⋯` does not show.
    if !cfg!(target_os = "macos") {
        let f5 = item("reload-f5".into(), "Reload Instance".into(), "F5".into())?;
        menu.append(&Submenu::with_items(app, "View", true, &[&f5])?)?;
    }
    Ok(menu)
}

/// The instance a menu item reloads: a tab menu's own, Reload Instance's the active one.
fn reloads(item: &str, active: impl FnOnce() -> Option<String>) -> Option<String> {
    match item {
        "reload" | "reload-f5" => active(),
        _ => item.strip_prefix("reload:").map(str::to_owned),
    }
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let shell = app.state::<Shell>();
    let done = match event.id().as_ref() {
        "add" => app
            .get_webview(TABS)
            .ok_or_else(|| "the tab bar is gone".to_owned())
            .and_then(|tabs| tabs.set_focus().map_err(text))
            .and_then(|()| app.emit_to(TABS, "add", ()).map_err(text)),
        "prev" => show_at(app, &shell, |at, len| at.map_or(0, |at| (at + len - 1) % len)),
        "next" => show_at(app, &shell, |at, len| at.map_or(0, |at| (at + 1) % len)),
        id => {
            if let Some(n) = id.strip_prefix("nth-").and_then(|n| n.parse::<usize>().ok()) {
                show_at(app, &shell, |_, _| n.saturating_sub(1))
            } else if let Some(id) = reloads(id, || shell.lock().active.clone()) {
                reload(app, &id)
            } else if id.starts_with("open:") || id.starts_with("remove:") {
                let (handle, item) = (app.clone(), id.to_owned());
                detach(app, async move {
                    match item.split_once(':') {
                        Some(("open", id)) => open(&handle, &handle.state::<Shell>(), id, None),
                        Some((_, id)) => remove(&handle, id).await,
                        None => Ok(()),
                    }
                });
                Ok(())
            } else {
                Ok(())
            }
        }
    };
    if let Err(e) = done {
        report(app, e);
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = if cfg!(debug_assertions) { "pier-client-dev" } else { "pier-client" };
    let shell = Shell { dir: app.path().config_dir()?.join(dir), state: Mutex::default() };
    let mut errors = Vec::new();
    let instances = store::load(&shell.store()).unwrap_or_else(|e| {
        errors.push(e);
        Vec::new()
    });
    shell.lock().instances = instances.clone();
    app.manage(shell);

    let handle = app.handle().clone();
    app.notification().on_action(move |performed| on_tap(&handle, performed))?;

    let window = WindowBuilder::new(app, WINDOW).title("Pier").inner_size(1200.0, 800.0).min_inner_size(640.0, 400.0);
    // The tab bar is the title bar: macOS keeps its traffic lights over the bar's left end,
    // elsewhere the bar draws the window's buttons.
    #[cfg(target_os = "macos")]
    let window = window.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).build()?;
    #[cfg(not(target_os = "macos"))]
    let window = window.decorations(false).build()?;
    #[cfg(not(target_os = "macos"))]
    window.hide_menu()?;
    let tabs = WebviewBuilder::new(TABS, WebviewUrl::App("index.html".into())).disable_drag_drop_handler();
    let _tabs = window.add_child(tabs, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1200.0, TABS_HEIGHT))?;
    #[cfg(target_os = "linux")]
    dock(&_tabs)?;
    let (resized, handle) = (window.clone(), app.handle().clone());
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
            if let Err(e) = layout(&resized) {
                report(&handle, format!("layout: {e}"));
            }
        }
    });

    let shell = app.state::<Shell>();
    for instance in instances.iter().filter(|i| !i.closed) {
        if let Err(e) = instance.app_url().and_then(|url| mount(app.handle(), &shell, instance, url)) {
            errors.push(format!("{}: {e}", instance.name));
        }
    }
    if let Some(first) = instances.iter().find(|i| !i.closed) {
        if let Err(e) = show_instance(app.handle(), &shell, &first.id) {
            errors.push(e);
        }
    }
    if !errors.is_empty() {
        let errors = errors.join("; ");
        eprintln!("pier-client: {errors}");
        shell.lock().startup_error = Some(errors);
    }
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .menu(menu)
        .on_menu_event(on_menu)
        .invoke_handler(tauri::generate_handler![
            list, add, close, rename, reorder, select, popup, set_badge, notify, page_title
        ])
        .setup(setup)
        .run(tauri::generate_context!());
    if let Err(e) = app {
        eprintln!("pier-client: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "main_test.rs"]
mod tests;
