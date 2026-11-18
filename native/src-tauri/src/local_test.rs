use super::*;

/// The tests' login shell: a POSIX sh, which reads `~/.profile` but never `~/.zshrc` or `~/.bashrc`,
/// on this process's PATH, built here rather than read so no test depends on another's environment.
fn plain_shell() -> LoginShell {
    let path = env::var("PATH").unwrap();
    LoginShell { shell: "/bin/sh".into(), path, failure: None, reported: AtomicBool::new(false) }
}

/// A home of its own holding `profile` as `.profile`, so no test reads the user's.
fn home_with(name: &str, profile: &str) -> PathBuf {
    let home = env::temp_dir().join(format!("pier-client-home-{name}-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".profile"), profile).unwrap();
    home
}

#[test]
fn the_port_is_the_commands_port_assignment_else_pier_s_default() {
    assert_eq!(port("/opt/bin/pier serve"), Ok(3141));
    assert_eq!(port("PIER_HOME=~/.pier-dev PORT=3200 pier serve"), Ok(3200));
    assert!(port("PORT=web pier serve").is_err());
}

#[test]
fn a_local_instance_is_on_the_loopback_port_its_command_names() {
    let (instance, first) = crate::store::Instance::local(" PORT=3200 node dist/cli.js serve ").unwrap();
    assert_eq!(first.as_str(), "http://127.0.0.1:3200/app/");
    assert_eq!(instance.url, "http://127.0.0.1:3200");
    assert_eq!(instance.command.as_deref(), Some("PORT=3200 node dist/cli.js serve"));
    assert!(crate::store::Instance::local("  ").is_err());
}

#[test]
fn sign_in_runs_the_command_with_login_for_serve_and_keeps_the_links_path() {
    let shell = plain_shell();
    let link = login(&shell, "echo profile noise; echo http://pier.example:3141/login/tok3n; true serve").unwrap();
    assert_eq!(link, Ok("/login/tok3n".to_owned()));
    let refused = login(&shell, "echo 'pier: no socket' >&2; false serve").unwrap().unwrap_err();
    assert!(refused.contains("pier: no socket"), "{refused}");
    assert!(login(&shell, "node dist/main.js").is_none());
}

#[test]
fn a_command_that_exits_before_listening_names_its_log() {
    let shell = plain_shell();
    let log = env::temp_dir().join(format!("pier-client-test-{}", std::process::id())).join("serve.log");
    let error = start(&shell, "echo starting; exit 3", 1, &log).unwrap_err();
    assert!(error.contains(&log.display().to_string()), "{error}");
    // The shell adds its own lines around it: bash its `logout`, dash with no tty its job-control warning.
    let logged = fs::read_to_string(&log).unwrap();
    assert!(logged.lines().any(|line| line == "starting"), "{logged}");
    fs::remove_dir_all(log.parent().unwrap()).unwrap();
}

#[test]
fn a_stop_ends_the_whole_process_group() {
    let started = Instant::now();
    let child = Command::new("/bin/sh").args(["-c", "sleep 30 & sleep 30"]).process_group(0).spawn().unwrap();
    let group = child.id();
    stop(child);
    assert!(started.elapsed() < Duration::from_secs(5));
    // `kill -0` on the group fails once no member is left.
    sleep(Duration::from_millis(200));
    let alive = Command::new("kill").args(["-0", "--", &format!("-{group}")]).stderr(Stdio::null()).status().unwrap();
    assert!(!alive.success());
}

#[test]
fn the_path_is_the_one_between_the_markers_without_escapes_or_relative_entries() {
    let out = format!("\x1b]7;file://mac/Users/me\x07profile noise\n\x1b[1;32m{BEGIN}/opt/homebrew/bin:.::bin:/usr/bin{END}\x1b[0m\nlogout\n");
    assert_eq!(parse_path(out.as_bytes()), Ok("/opt/homebrew/bin:/usr/bin".to_owned()));
    assert_eq!(strip_escapes(b"a\x1b]0;title\x1b\\b\x1b(Bc"), b"abc");
    for refused in [
        "no markers: /usr/bin".to_owned(),
        format!("{END}/usr/bin{BEGIN}"),
        format!("{BEGIN}/a{END}{BEGIN}/b{END}"),
        format!("{BEGIN}/usr/bin\n/opt/bin{END}"),
        format!("{BEGIN}bin:.{END}"),
        format!("{BEGIN}{END}"),
    ] {
        assert!(parse_path(refused.as_bytes()).is_err(), "{refused:?}");
    }
    assert!(parse_path(&[BEGIN.as_bytes(), b"/\xff", END.as_bytes()].concat()).is_err());
}

#[test]
fn a_shell_s_output_is_read_within_its_budget_and_cap() {
    let sh = |script: &str| {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    };
    assert_eq!(bounded(sh("printf hi; exit 1"), Duration::from_secs(3), 16), Ok(b"hi".to_vec()));
    assert!(bounded(sh("yes"), Duration::from_secs(3), 1024).unwrap_err().contains("more than 1024 bytes"));
    let started = Instant::now();
    let pid = env::temp_dir().join(format!("pier-client-bounded-{}", std::process::id()));
    let script = format!("sleep 30 & echo $! > '{}'; wait", pid.display());
    let error = bounded(sh(&script), Duration::from_millis(500), 1024).unwrap_err();
    assert!(error.contains("no output within 0.5s"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(3));
    // The shell's own children went with it.
    sleep(Duration::from_millis(200));
    let sleeper = fs::read_to_string(&pid).unwrap();
    fs::remove_file(&pid).unwrap();
    let alive = Command::new("kill").args(["-0", sleeper.trim()]).stderr(Stdio::null()).status().unwrap();
    assert!(!alive.success());
}

#[test]
fn a_shell_path_is_read_from_a_login_shell_in_its_home() {
    let home = home_with("read", "PATH=\"/from/profile:$(pwd):$HOME\"\n");
    let path = shell_path(Path::new("/bin/sh"), Some(&home), Duration::from_secs(3)).unwrap();
    assert_eq!(path, format!("/from/profile:{0}:{0}", home.display()));
    assert!(shell_path(Path::new("/nonexistent/zsh"), Some(&home), Duration::from_secs(3)).is_err());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn pier_is_the_first_executable_on_the_path_and_quoted_when_the_shell_would_split_it() {
    let root = env::temp_dir().join(format!("pier-client-find-{}", std::process::id()));
    let (plain, spaced, bin) = (root.join("plain"), root.join("Application Support"), root.join("bin"));
    for dir in [&plain, &spaced, &bin] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(plain.join("pier"), "").unwrap();
    fs::create_dir(bin.join("pier")).unwrap();
    fs::write(spaced.join("pier"), "").unwrap();
    fs::set_permissions(spaced.join("pier"), fs::Permissions::from_mode(0o755)).unwrap();
    // Not executable, then a directory: both passed over.
    let path = format!("{}:{}:relative:{}", plain.display(), bin.display(), spaced.display());
    let pier = find("pier", &path).unwrap();
    assert_eq!(pier, spaced.join("pier"));
    assert_eq!(suggestion(&pier.to_string_lossy()), Ok(format!("'{}' serve", pier.display())));
    assert_eq!(suggestion("/opt/homebrew/bin/pier"), Ok("/opt/homebrew/bin/pier serve".to_owned()));
    assert!(suggestion("/it's/pier").is_err());
    assert!(find("pier", &plain.display().to_string()).is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_search_path_is_the_shell_s_then_the_install_directories_it_lacks() {
    let home = home_with("search", "PATH=\"/from/profile:/usr/local/bin\"\n");
    let shell = LoginShell::read(Some("/bin/sh".into()), Some(&home), "/inherited");
    assert!(shell.unreported_failure().is_none());
    let npm = format!("{}/.npm-global/bin", home.display());
    let dirs: Vec<&str> = shell.path.split(':').collect();
    assert_eq!(dirs[..3], ["/from/profile", "/usr/local/bin", "/opt/homebrew/bin"]);
    assert_eq!(dirs[3], npm);
    assert_eq!(search_path("relative:/a:/opt/homebrew/bin", None), "/a:/opt/homebrew/bin:/usr/local/bin");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_failed_read_is_kept_reported_once_and_the_app_s_path_stands_in() {
    let home = home_with("failed", "exit 1\n");
    let shell = LoginShell::read(Some("/bin/sh".into()), Some(&home), "/inherited");
    assert!(shell.path.starts_with("/inherited:/opt/homebrew/bin:"), "{}", shell.path);
    assert!(shell.unreported_failure().is_some_and(|e| e.contains("no PATH between markers")));
    assert!(shell.unreported_failure().is_none());
    let missing = suggested(&shell).unwrap_err();
    assert!(missing.starts_with("no executable `pier` in /inherited, /opt/homebrew/bin, "), "{missing}");
    fs::remove_dir_all(home).unwrap();
}
