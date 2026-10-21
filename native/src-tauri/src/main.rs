//! Pier's native client: one frameless window, a tab per Pier instance over one webview each.

mod store;

use std::{
    collections::HashMap,
    fmt::Display,
    fs,
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
    menu::{Menu, MenuEvent, MenuItem, Submenu},
    webview::{NewWindowResponse, PageLoadEvent},
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl, Window,
    WindowEvent,
};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

const WINDOW: &str = "main";
const TABS: &str = "tabs";
const TABS_HEIGHT: f64 = 38.0;
const INSTANCES: &str = "instances";

type Res<T = ()> = Result<T, String>;

struct Shell {
    /// `pier-client/` in the platform config dir: the list and every instance's data.
    dir: PathBuf,
    state: Mutex<Live>,
}

#[derive(Default)]
struct Live {
    instances: Vec<Instance>,
    unread: HashMap<String, u32>,
    accent: HashMap<String, String>,
    active: Option<String>,
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
    let rows: Vec<Value> = live
        .instances
        .iter()
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
    let capability = ["allow-set-badge", "allow-notify", "allow-page-title"].into_iter().fold(
        CapabilityBuilder::new(format!("instance-{}", instance.id))
            .webview(&instance.id)
            .remote(instance.url.clone())
            .local(false),
        CapabilityBuilder::permission,
    );
    app.add_capability(capability).map_err(text)?;
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

/// Shows the instance `pick` names from the active one's index and the count; none when the list is empty.
fn show_at(app: &AppHandle, shell: &Shell, pick: impl FnOnce(Option<usize>, usize) -> usize) -> Res {
    let id = {
        let live = shell.lock();
        let (all, len) = (&live.instances, live.instances.len());
        let active = live.active.as_deref().and_then(|a| position(all, a).ok());
        (len > 0).then(|| pick(active, len)).and_then(|n| all.get(n)).map(|i| i.id.clone())
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

/// Why `origin` does not look like Pier, if it does not: every Pier serves `/login`, signed
/// out, as a page titled "Pier". Loaded in a hidden throwaway webview with no cookie jar
/// and no IPC, so the shell still opens no connection of its own.
async fn probe(app: &AppHandle, instance: &Instance) -> Res<Option<String>> {
    const WAIT: Duration = Duration::from_secs(10);
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
    let waited = tauri::async_runtime::spawn_blocking(move || {
        let (deadline, mut title) = (Instant::now() + WAIT, String::new());
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Probed::Title(t)) if t == "Pier" => return None,
                Ok(Probed::Title(t)) => title = t,
                Ok(Probed::Loaded) if title.is_empty() => return Some("its /login did not load".to_owned()),
                Ok(Probed::Loaded) => return Some(format!("its /login is titled \"{title}\"")),
                Ok(Probed::Left(url)) => return Some(format!("it redirects to {url}")),
                Err(_) => return Some(format!("no answer within {}s", WAIT.as_secs())),
            }
        }
    });
    let verdict = waited.await.map_err(text);
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

#[tauri::command]
fn remove(app: AppHandle, shell: State<'_, Shell>, id: String) -> Res {
    let mut at = 0;
    edit(&app, &shell, |all| {
        at = position(all, &id)?;
        all.remove(at);
        Ok(())
    })?;
    if let Some(webview) = app.get_webview(&id) {
        webview.close().map_err(text)?;
    }
    match fs::remove_dir_all(shell.data_dir(&id)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(format!("removing the instance's data: {e}")),
        _ => {}
    }
    let mut live = shell.lock();
    live.unread.remove(&id);
    live.accent.remove(&id);
    publish(&app, &mut live);
    let was_active = live.active.take_if(|active| *active == id).is_some();
    drop(live);
    if was_active {
        return show_at(&app, &shell, |_, len| at.min(len - 1));
    }
    Ok(())
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

#[tauri::command]
fn reorder(app: AppHandle, shell: State<'_, Shell>, id: String, to: usize) -> Res {
    edit(&app, &shell, |all| {
        let instance = all.remove(position(all, &id)?);
        all.insert(to.min(all.len()), instance);
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

#[tauri::command]
fn notify(app: AppHandle, webview: Webview, title: String, body: String, url: String, tag: String) -> Res {
    if !url.starts_with("/app/") {
        return surfaced(&app, Err(format!("not a workbench path: {url}")));
    }
    // As Web Push's `tag`: a session's later notification replaces its earlier
    // one, where the platform can close it (Linux; macOS stacks regardless).
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

/// A click on a notification brings the window, then the instance, then the page at `url`.
fn on_tap(app: &AppHandle, performed: &ActionPerformed) {
    if performed.action_id() != "tap" {
        return;
    }
    let (Some(id), Some(url)) = (instance_field(performed, "instance"), instance_field(performed, "url")) else {
        return report(app, "a notification click arrived without its instance");
    };
    let window = app.get_window(WINDOW);
    let opened = window
        .ok_or_else(|| "the window is gone".to_owned())
        .and_then(|w| w.unminimize().and_then(|()| w.show()).and_then(|()| w.set_focus()).map_err(text))
        .and_then(|()| show_instance(app, &app.state::<Shell>(), id))
        // Set from here, not sent as an event: an instance page holds no event
        // permission, so no page can hear another's.
        .and_then(|()| app.get_webview(id).ok_or_else(|| format!("{id} has no webview")))
        .and_then(|w| {
            let hash = url.split_once('#').map_or("", |(_, hash)| hash);
            w.eval(format!("location.hash = {}", Value::from(hash))).map_err(text)
        });
    if let Err(e) = opened {
        report(app, format!("opening a notification: {e}"));
    }
}

/// The tab bar's menu button: the Instances menu, dropped at `x`, `y` in the bar.
#[tauri::command]
fn popup(app: AppHandle, window: Window, x: f64, y: f64) -> Res {
    let menu = app.menu().and_then(|m| m.get(INSTANCES)).and_then(|i| i.as_submenu().cloned());
    let menu = menu.ok_or("no Instances menu")?;
    window.popup_menu_at(&menu, LogicalPosition::new(x, y)).map_err(text)
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
        ],
    )?;
    for n in 1..=9 {
        instances.append(&item(format!("nth-{n}"), format!("Instance {n}"), format!("CmdOrCtrl+{n}"))?)?;
    }
    menu.append(&instances)?;
    Ok(menu)
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
        id => match id.strip_prefix("nth-").and_then(|n| n.parse::<usize>().ok()) {
            Some(n) => show_at(app, &shell, |_, _| n.saturating_sub(1)),
            None => Ok(()),
        },
    };
    if let Err(e) = done {
        report(app, e);
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let shell = Shell { dir: app.path().config_dir()?.join("pier-client"), state: Mutex::default() };
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
    for instance in &instances {
        if let Err(e) = instance.app_url().and_then(|url| mount(app.handle(), &shell, instance, url)) {
            errors.push(format!("{}: {e}", instance.name));
        }
    }
    if let Some(first) = instances.first() {
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
            list, add, remove, rename, reorder, select, popup, set_badge, notify, page_title
        ])
        .setup(setup)
        .run(tauri::generate_context!());
    if let Err(e) = app {
        eprintln!("pier-client: {e}");
        std::process::exit(1);
    }
}
