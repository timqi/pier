//! A Pier on this machine whose process the shell owns: found, started, signed into and stopped
//! through the user's login shell.

use std::{
    env,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread::{self, sleep},
    time::{Duration, Instant},
};

use tauri::Url;

const DEFAULT_PORT: u16 = 3141;

/// A GUI app's PATH lacks what the user's profile adds (fnm, Homebrew); an interactive login
/// shell has it, as `~/.zshrc` is read only by an interactive zsh.
fn login_shell(script: &str) -> Command {
    let mut command = Command::new(env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    // Its own process group, so a stop or a timeout reaches what the script started.
    command.arg("-lic").arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    command
}

/// The login shell's output for `script`, its process group killed after 20s: a profile can wait
/// on input or the network.
fn output(script: &str) -> Result<Output, String> {
    let child = login_shell(script).spawn().map_err(|e| format!("`{script}`: {e}"))?;
    let (group, (tx, rx)) = (format!("-{}", child.id()), mpsc::channel());
    thread::spawn(move || drop(tx.send(child.wait_with_output())));
    let Ok(out) = rx.recv_timeout(Duration::from_secs(20)) else {
        signal("-KILL", &group);
        return Err(format!("`{script}` did not finish within 20s"));
    };
    out.map_err(|e| format!("`{script}`: {e}"))
}

/// `<pier's absolute path> serve`, or empty when the login shell finds no `pier`.
pub fn suggested() -> Result<String, String> {
    let found = output("command -v pier")?;
    let out = found.status.success().then(|| String::from_utf8_lossy(&found.stdout).into_owned());
    // The last absolute path: an interactive shell's profile may print, and bash's `logout` follows.
    let path = out.as_deref().and_then(|out| out.lines().map(str::trim).rfind(|l| l.starts_with('/')));
    // A path the shell would split or unquote is left for the user to write.
    let plain = |path: &&str| !path.contains(|c: char| c.is_whitespace() || "'\"\\$".contains(c));
    Ok(path.filter(plain).map(|path| format!("{path} serve")).unwrap_or_default())
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
pub fn start(command: &str, port: u16, log: &Path) -> Result<Child, String> {
    let shown = log.display();
    let opened = log.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| {
        let out = OpenOptions::new().create(true).append(true).open(log)?;
        Ok((out.try_clone()?, out))
    });
    let (err, out) = opened.map_err(|e| format!("{shown}: {e}"))?;
    let spawned = login_shell(command).stdout(out).stderr(err).spawn();
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
pub fn login(command: &str) -> Option<Result<String, String>> {
    let script = format!("{} login", command.trim().strip_suffix("serve")?);
    Some(output(&script).and_then(|out| {
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
