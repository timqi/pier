//! A Pier on this machine whose process the shell owns: found, started, signed into and stopped
//! through the user's login shell.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{self, OpenOptions},
    io::Read,
    net::{SocketAddr, TcpStream},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    thread::{self, sleep},
    time::{Duration, Instant},
};

use tauri::Url;

const DEFAULT_PORT: u16 = 3141;
const BEGIN: &str = "__PIER_PATH_BEGIN__";
const END: &str = "__PIER_PATH_END__";
/// Where Pier's installs put `pier` and `node`, searched after the login shell's PATH; `~/` is `$HOME`.
const INSTALL_DIRS: [&str; 7] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.npm-global/bin",
    "~/.local/bin",
    "~/.volta/bin",
    "~/.local/share/fnm/aliases/default/bin",
    "~/Library/Application Support/fnm/aliases/default/bin",
];

/// `$SHELL` when it takes `-ilc` and prints `$PATH` joined by `:` as a POSIX shell does, else zsh.
fn pick_shell(shell: Option<OsString>) -> PathBuf {
    let posix =
        |s: &PathBuf| matches!(s.file_name().and_then(OsStr::to_str), Some("zsh" | "bash" | "sh" | "ksh" | "dash"));
    let shell = shell.map(PathBuf::from);
    shell.filter(|s| s.is_absolute() && posix(s) && executable(s)).unwrap_or_else(|| "/bin/zsh".into())
}

/// What a local Pier's commands run in: the user's login shell and the PATH they start from.
pub struct LoginShell {
    shell: PathBuf,
    path: String,
    /// Why the shell gave no PATH, the app's own standing in.
    failure: Option<String>,
    reported: AtomicBool,
}

static LOGIN_SHELL: OnceLock<LoginShell> = OnceLock::new();

impl LoginShell {
    /// This app's, read on first need and kept for its life, a failed read too: reading runs the
    /// user's whole profile, up to 3s. The app's own environment is left as launchd gave it.
    pub fn get() -> &'static LoginShell {
        LOGIN_SHELL.get_or_init(|| {
            let inherited = env::var("PATH").unwrap_or_default();
            LoginShell::read(env::var_os("SHELL"), env::var_os("HOME").map(PathBuf::from).as_deref(), &inherited)
        })
    }

    fn read(shell: Option<OsString>, home: Option<&Path>, inherited: &str) -> LoginShell {
        let shell = pick_shell(shell);
        let read = shell_path(&shell, home, Duration::from_secs(3));
        let path = search_path(read.as_deref().unwrap_or(inherited), home);
        LoginShell { shell, path, failure: read.err(), reported: AtomicBool::new(false) }
    }

    /// Why the shell gave no PATH, once: the caller reports it.
    pub fn unreported_failure(&self) -> Option<String> {
        self.failure.clone().filter(|_| !self.reported.swap(true, Ordering::Relaxed))
    }

    /// A GUI app's PATH lacks what the user's profile adds (fnm, Homebrew); an interactive login
    /// shell has it, as `~/.zshrc` is read only by an interactive zsh. It starts from `search_path`'s,
    /// so a profile that adds nothing still finds an install directory's `pier` and `node`.
    fn command(&self, script: &str) -> Command {
        let mut command = Command::new(&self.shell);
        command.arg("-lic").arg(script).env("PATH", &self.path);
        // Its own process group, so a stop or a timeout reaches what the script started.
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        command
    }
}

/// `base`'s absolute directories, then the install directories it lacks.
fn search_path(base: &str, home: Option<&Path>) -> String {
    let extra = INSTALL_DIRS.iter().filter_map(|dir| match dir.strip_prefix("~/") {
        Some(rest) => home.map(|home| home.join(rest).to_string_lossy().into_owned()),
        None => Some((*dir).to_owned()),
    });
    let mut dirs: Vec<String> = base.split(':').filter(|d| d.starts_with('/')).map(str::to_owned).collect();
    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

/// `shell -ilc` printing its PATH between markers, within `budget`, run in and with `home`.
fn shell_path(shell: &Path, home: Option<&Path>, budget: Duration) -> Result<String, String> {
    let mut command = Command::new(shell);
    command.arg("-ilc").arg(format!("printf '\\n{BEGIN}%s{END}\\n' \"$PATH\""));
    // Oh My Zsh's update prompt would wait on input; a profile's relative paths assume the home.
    command.env("DISABLE_AUTO_UPDATE", "true");
    if let Some(home) = home {
        command.current_dir(home).env("HOME", home);
    }
    let out = bounded(command, budget, 64 * 1024).map_err(|e| format!("{}: {e}", shell.display()))?;
    parse_path(&out).map_err(|e| format!("{}: {e}", shell.display()))
}

/// The command's stdout, at most `cap` bytes, its process group killed and reaped once `budget`
/// runs out: a profile can wait on input or the network, or print without end.
fn bounded(mut command: Command, budget: Duration, cap: u64) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + budget;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let (group, mut stdout, (tx, rx)) = (format!("-{}", child.id()), child.stdout.take(), mpsc::channel());
    thread::spawn(move || {
        let mut out = Vec::new();
        let read = stdout.as_mut().map_or(Ok(0), |s| s.take(cap + 1).read_to_end(&mut out));
        drop(tx.send(read.map(|_| out)));
    });
    let read = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let over = matches!(&read, Ok(Ok(out)) if out.len() as u64 > cap);
    // Printed in full, the shell may still be exiting.
    while !over && matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        sleep(Duration::from_millis(10));
    }
    if !matches!(child.try_wait(), Ok(Some(_))) {
        signal("-KILL", &group);
    }
    if let Err(e) = child.wait() {
        eprintln!("pier-client: waiting on {group}: {e}");
    }
    match read {
        Err(_) => Err(format!("no output within {}s", budget.as_secs_f32())),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(_)) if over => Err(format!("more than {cap} bytes of output")),
        Ok(Ok(out)) => Ok(out),
    }
}

/// The PATH between the one pair of markers, terminal escapes removed; its relative and empty entries
/// dropped, as they would resolve against whatever directory a command runs in.
fn parse_path(out: &[u8]) -> Result<String, String> {
    let text = String::from_utf8(strip_escapes(out)).map_err(|_| "output is not UTF-8".to_owned())?;
    let (Some(begin), Some(end)) = (text.find(BEGIN), text.find(END)) else {
        return Err("no PATH between markers in its output".into());
    };
    if text.matches(BEGIN).count() != 1 || text.matches(END).count() != 1 || end < begin {
        return Err("its output does not hold one PATH between markers".into());
    }
    let path = &text[begin + BEGIN.len()..end];
    if path.contains(char::is_control) {
        return Err("its PATH holds a control character".into());
    }
    let dirs: Vec<&str> = path.split(':').filter(|d| d.starts_with('/')).collect();
    if dirs.is_empty() {
        return Err(format!("no absolute directory in its PATH {path:?}"));
    }
    Ok(dirs.join(":"))
}

/// `out` without ANSI escapes: CSI to its final byte, OSC to BEL or ST, any other past its
/// intermediate bytes to its final one.
fn strip_escapes(out: &[u8]) -> Vec<u8> {
    let mut kept = Vec::with_capacity(out.len());
    let mut bytes = out.iter().copied().peekable();
    while let Some(byte) = bytes.next() {
        if byte != 0x1b {
            kept.push(byte);
            continue;
        }
        match bytes.next() {
            Some(b'[') => while bytes.next().is_some_and(|b| !(0x40..=0x7e).contains(&b)) {},
            Some(b']') => {
                while let Some(b) = bytes.next() {
                    if b == 0x07 || (b == 0x1b && bytes.next_if_eq(&b'\\').is_some()) {
                        break;
                    }
                }
            }
            Some(0x20..=0x2f) => {
                while bytes.next_if(|b| (0x20..=0x2f).contains(b)).is_some() {}
                bytes.next();
            }
            _ => {}
        }
    }
    kept
}

fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The first executable `name` in the colon-separated `path`.
fn find(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').map(|dir| Path::new(dir).join(name)).find(|file| executable(file))
}

/// The login shell's output for `script`, its process group killed after 20s: a profile can wait
/// on input or the network.
fn output(shell: &LoginShell, script: &str) -> Result<Output, String> {
    let child = shell.command(script).spawn().map_err(|e| format!("`{script}`: {e}"))?;
    let (group, (tx, rx)) = (format!("-{}", child.id()), mpsc::channel());
    thread::spawn(move || drop(tx.send(child.wait_with_output())));
    let Ok(out) = rx.recv_timeout(Duration::from_secs(20)) else {
        signal("-KILL", &group);
        return Err(format!("`{script}` did not finish within 20s"));
    };
    out.map_err(|e| format!("`{script}`: {e}"))
}

/// `<pier's absolute path> serve`, `pier` found on the shell's PATH.
pub fn suggested(shell: &LoginShell) -> Result<String, String> {
    let Some(pier) = find("pier", &shell.path) else {
        return Err(format!("no executable `pier` in {}", shell.path.replace(':', ", ")));
    };
    suggestion(&pier.to_string_lossy())
}

/// `<pier> serve`, the path quoted when the shell would split or expand it.
fn suggestion(pier: &str) -> Result<String, String> {
    if !pier.contains(|c: char| c.is_whitespace() || "'\"\\$`".contains(c)) {
        Ok(format!("{pier} serve"))
    } else if !pier.contains(|c: char| c == '\'' || c.is_control()) {
        Ok(format!("'{pier}' serve"))
    } else {
        Err(format!("`pier` is at {pier:?}, a path to write into the command by hand"))
    }
}

/// The port the command's `PORT=` assigns, else Pier's default.
pub fn port(command: &str) -> Result<u16, String> {
    match command.split_whitespace().find_map(|word| word.strip_prefix("PORT=")) {
        Some(port) => port.parse().map_err(|_| format!("not a port: PORT={port}")),
        None => Ok(DEFAULT_PORT),
    }
}

pub fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

/// Spawned in a process group of its own, so a stop reaches what the command started; returns
/// once the port answers.
pub fn start(shell: &LoginShell, command: &str, port: u16, log: &Path) -> Result<Child, String> {
    let shown = log.display();
    let opened = log.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| {
        let out = OpenOptions::new().create(true).append(true).open(log)?;
        Ok((out.try_clone()?, out))
    });
    let (err, out) = opened.map_err(|e| format!("{shown}: {e}"))?;
    let spawned = shell.command(command).stdout(out).stderr(err).spawn();
    let mut child = spawned.map_err(|e| format!("starting `{command}`: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !listening(port) {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("`{command}` exited ({status}); see {shown}"));
        }
        if Instant::now() > deadline {
            stop(child);
            return Err(format!("`{command}` did not listen on port {port} within 60s; see {shown}"));
        }
        sleep(Duration::from_millis(200));
    }
    Ok(child)
}

/// The path of a one-time sign-in link, the output line that is one: the command with `serve`
/// swapped for `login`, so it reaches the same `PIER_HOME`. None for a command that does not end in `serve`.
pub fn login(shell: &LoginShell, command: &str) -> Option<Result<String, String>> {
    let script = format!("{} login", command.trim().strip_suffix("serve")?);
    Some(output(shell, &script).and_then(|out| {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut links = text.lines().filter_map(|line| Url::parse(line.trim()).ok());
        let link = links.find(|u| out.status.success() && u.path().starts_with("/login/")).map(|u| u.path().to_owned());
        link.ok_or_else(|| format!("`{script}`: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }))
}

/// SIGTERM to the process group, SIGKILL after 10s.
pub fn stop(mut child: Child) {
    let group = format!("-{}", child.id());
    signal("-TERM", &group);
    let deadline = Instant::now() + Duration::from_secs(10);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        sleep(Duration::from_millis(100));
    }
    if !matches!(child.try_wait(), Ok(Some(_))) {
        signal("-KILL", &group);
    }
    if let Err(e) = child.wait() {
        eprintln!("pier-client: waiting on {group}: {e}");
    }
}

fn signal(name: &str, group: &str) {
    if let Err(e) = Command::new("kill").args([name, "--", group]).status() {
        eprintln!("pier-client: kill {name} {group}: {e}");
    }
}

#[cfg(test)]
#[path = "local_test.rs"]
mod tests;
