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
