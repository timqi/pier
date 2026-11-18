use super::*;

/// The tests' login shell: /bin/sh reads no profile, so nothing of the user's runs.
fn plain_shell() {
    env::set_var("SHELL", "/bin/sh");
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
    plain_shell();
    let link = login("echo profile noise; echo http://pier.example:3141/login/tok3n; true serve").unwrap();
    assert_eq!(link, Ok("/login/tok3n".to_owned()));
    let refused = login("echo 'pier: no socket' >&2; false serve").unwrap().unwrap_err();
    assert!(refused.contains("pier: no socket"), "{refused}");
    assert!(login("node dist/main.js").is_none());
}

#[test]
fn a_command_that_exits_before_listening_names_its_log() {
    plain_shell();
    let log = env::temp_dir().join(format!("pier-client-test-{}", std::process::id())).join("serve.log");
    let error = start("echo starting; exit 3", 1, &log).unwrap_err();
    assert!(error.contains(&log.display().to_string()), "{error}");
    // An interactive login bash, as /bin/sh is, adds its `logout`.
    assert!(fs::read_to_string(&log).unwrap().starts_with("starting\n"));
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
fn a_shell_path_is_read_from_a_login_shell() {
    // A login sh reads `~/.profile`, whatever it holds: only the framing is checked.
    let path = shell_path(Path::new("/bin/sh"), Duration::from_secs(3));
    assert!(path.is_ok_and(|p| p.split(':').all(|d| d.starts_with('/'))));
    assert!(shell_path(Path::new("/nonexistent/zsh"), Duration::from_secs(3)).is_err());
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
fn the_search_path_ends_in_the_install_directories_it_lacks() {
    plain_shell();
    let (path, _) = search_path();
    assert!(path.contains(":/opt/homebrew/bin") || path.starts_with("/opt/homebrew/bin"));
    assert_eq!(path.split(':').filter(|d| *d == "/usr/local/bin").count(), 1);
    assert!(path.split(':').all(|d| d.starts_with('/')));
}
