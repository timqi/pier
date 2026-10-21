//! Pier's native client: one window, a rail of Pier instances, one webview per instance.

mod store;

use std::{
    collections::HashMap,
    fmt::Display,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io,
    path::PathBuf,
    process::Command,
    sync::{Mutex, MutexGuard, PoisonError},
};

use serde_json::{json, Value};
use store::Instance;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, Submenu},
    webview::NewWindowResponse,
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl, Window,
    WindowEvent,
};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

const WINDOW: &str = "main";
const RAIL: &str = "rail";
const RAIL_WIDTH: f64 = 200.0;

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
    /// What went wrong before the rail could show it; `list` hands it over.
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

/// Logs `message` and shows it on the rail: a failure is never only a log line.
fn report(app: &AppHandle, message: impl Display) {
    eprintln!("pier-client: {message}");
    if let Err(e) = app.emit_to(RAIL, "error", message.to_string()) {
        eprintln!("pier-client: the rail missed that: {e}");
    }
}

/// An instance's command failing shows on the rail too, not only in its page's console.
fn surfaced(app: &AppHandle, result: Res) -> Res {
    if let Err(e) = &result {
        report(app, e);
    }
    result
}

/// Pushes the rows to the rail and their unread sum to the Dock / taskbar badge.
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
    if let Err(e) = app.emit_to(RAIL, "state", &rows) {
        eprintln!("pier-client: the rail missed a state: {e}");
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

/// The rail docked left at a fixed width, every instance filling the rest; on Linux these
/// calls are no-ops and GTK lays out the row `dock` builds.
fn layout(window: &Window) -> tauri::Result<()> {
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    for webview in window.webviews() {
        let (x, width) =
            if webview.label() == RAIL { (0.0, RAIL_WIDTH) } else { (RAIL_WIDTH, (size.width - RAIL_WIDTH).max(0.0)) };
        webview.set_position(LogicalPosition::new(x, 0.0))?;
        webview.set_size(LogicalSize::new(width, size.height))?;
    }
    Ok(())
}

/// GTK packs each child webview into the window's vertical box, where position and size are
/// no-ops: each moves into Pier's horizontal row under the menu bar, the rail at its fixed width.
#[cfg(target_os = "linux")]
fn dock(webview: &Webview) -> tauri::Result<()> {
    use gtk::prelude::*;
    const ROW: &str = "pier-row";
    let (app, label, rail) = (webview.app_handle().clone(), webview.label().to_owned(), webview.label() == RAIL);
    webview.with_webview(move |platform| {
        let widget = platform.inner().upcast::<gtk::Widget>();
        let Some(vbox) = widget.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
            return report(&app, format!("layout: {label} is not in the window's box"));
        };
        let row = match vbox.children().into_iter().find(|c| c.widget_name() == ROW) {
            Some(found) => match found.downcast::<gtk::Box>() {
                Ok(row) => row,
                Err(_) => return report(&app, format!("layout: {ROW} is not a box; {label} left where GTK put it")),
            },
            None => {
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                row.set_widget_name(ROW);
                vbox.pack_start(&row, true, true, 0);
                row.show();
                row
            }
        };
        vbox.remove(&widget);
        row.pack_start(&widget, !rail, true, 0);
        if rail {
            widget.set_size_request(RAIL_WIDTH as i32, -1);
        }
    })
}

/// A link the page opens in a new window goes to the system browser.
fn open_external(url: &Url) -> io::Result<()> {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err(io::Error::other("not a web link"));
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let mut child = Command::new(opener).arg(url.as_str()).spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Adds an instance's webview, hidden, over a persistent data store of its own.
fn mount(app: &AppHandle, shell: &Shell, instance: &Instance, first: Url) -> Res {
    let window = app.get_window(WINDOW).ok_or("the window is gone")?;
    let opener = app.clone();
    let builder = WebviewBuilder::new(&instance.id, WebviewUrl::External(first))
        .data_directory(shell.data_dir(&instance.id))
        .disable_drag_drop_handler()
        .on_new_window(move |url, _| {
            if let Err(e) = open_external(&url) {
                report(&opener, format!("opening {url}: {e}"));
            }
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store::store_key(&instance.id));
    let at = LogicalPosition::new(RAIL_WIDTH, 0.0);
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

/// The rail is ready: it gets the rows, and anything that failed before it could listen.
#[tauri::command]
fn list(app: AppHandle, shell: State<'_, Shell>) -> Res {
    let mut live = shell.lock();
    publish(&app, &mut live);
    live.startup_error.take().map_or(Ok(()), Err)
}

/// Async: building a webview from a sync command, which runs on the main thread, can deadlock.
#[tauri::command]
async fn add(app: AppHandle, shell: State<'_, Shell>, input: String) -> Res {
    let (instance, first) = Instance::parse(&input)?;
    edit(&app, &shell, |all| {
        all.push(instance.clone());
        Ok(())
    })?;
    mount(&app, &shell, &instance, first)?;
    show_instance(&app, &shell, &instance.id)
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

/// Accelerators on the app menu, so they fire while an instance's page has focus.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let item = |id: String, label: String, keys: String| MenuItem::with_id(app, id, label, true, Some(keys));
    let instances = Submenu::with_items(
        app,
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
            .get_webview(RAIL)
            .ok_or_else(|| "the rail is gone".to_owned())
            .and_then(|rail| rail.set_focus().map_err(text))
            .and_then(|()| app.emit_to(RAIL, "add", ()).map_err(text)),
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

    let window =
        WindowBuilder::new(app, WINDOW).title("Pier").inner_size(1200.0, 800.0).min_inner_size(640.0, 400.0).build()?;
    let rail = WebviewBuilder::new(RAIL, WebviewUrl::App("index.html".into())).disable_drag_drop_handler();
    let _rail = window.add_child(rail, LogicalPosition::new(0.0, 0.0), LogicalSize::new(RAIL_WIDTH, 800.0))?;
    #[cfg(target_os = "linux")]
    dock(&_rail)?;
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
            list, add, remove, rename, reorder, select, set_badge, notify, page_title
        ])
        .setup(setup)
        .run(tauri::generate_context!());
    if let Err(e) = app {
        eprintln!("pier-client: {e}");
        std::process::exit(1);
    }
}
