use std::{fs, path::PathBuf};

use super::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pier-client-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir.join("instances.json")
}

#[test]
fn a_url_is_its_origin_and_loads_the_workbench() {
    let (instance, first) = Instance::parse(" https://pier.example.com/app/#s ").unwrap();
    assert_eq!(instance.url, "https://pier.example.com");
    assert_eq!(instance.name, "pier.example.com");
    assert_eq!(first.as_str(), "https://pier.example.com/app/");
    assert!(valid(&instance));
}

#[test]
fn a_login_link_is_loaded_first_so_it_signs_in() {
    let (instance, first) = Instance::parse("http://10.0.0.2:3142/login/tok").unwrap();
    assert_eq!(instance.url, "http://10.0.0.2:3142");
    assert_eq!(first.as_str(), "http://10.0.0.2:3142/login/tok");
    assert_eq!(instance.app_url().unwrap().as_str(), "http://10.0.0.2:3142/app/");
}

#[test]
fn anything_but_a_web_url_is_refused() {
    assert!(Instance::parse("pier.example.com").is_err());
    assert!(Instance::parse("file:///etc/passwd").is_err());
}

#[test]
fn ids_are_distinct() {
    let (a, _) = Instance::parse("https://a.example").unwrap();
    let (b, _) = Instance::parse("https://a.example").unwrap();
    assert_ne!(a.id, b.id);
}

#[test]
fn the_list_round_trips_and_starts_empty() {
    let path = scratch("round-trip");
    assert!(load(&path).unwrap().is_empty());
    let (instance, _) = Instance::parse("https://a.example").unwrap();
    save(&path, std::slice::from_ref(&instance)).unwrap();
    let loaded = load(&path).unwrap();
    assert_eq!(loaded[0].id, instance.id);
    assert!(!fs::read_to_string(&path).unwrap().contains("named"));
}

#[test]
fn a_malformed_list_is_set_aside_not_overwritten() {
    let path = scratch("malformed");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"[{"id":"../x","name":"n","url":"https://a.example"}]"#).unwrap();
    assert!(load(&path).err().unwrap().contains("set aside"));
    assert!(!path.exists());
    assert!(path.with_extension("json.bad").exists());
}

#[test]
fn a_list_that_is_not_utf8_is_set_aside_too() {
    let path = scratch("not-utf8");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"[\xff]").unwrap();
    assert!(load(&path).err().unwrap().contains("set aside"));
    assert!(path.with_extension("json.bad").exists());
}

#[test]
fn the_tab_keeps_its_own_origin_and_nothing_else() {
    let (instance, _) = Instance::parse("http://127.0.0.1:3142/login/tok").unwrap();
    let keeps = |url: &str| instance.keeps(&Url::parse(url).unwrap());
    assert!(keeps("http://127.0.0.1:3142/login/other"));
    assert!(keeps("http://127.0.0.1:3142/app/#s/1"));
    assert!(keeps("blob:http://127.0.0.1:3142/6f1c"));
    assert!(keeps("about:blank"));
    assert!(!keeps("https://127.0.0.1:3142/app/"));
    assert!(!keeps("http://127.0.0.1:3143/app/"));
    assert!(!keeps("http://localhost:3142/app/"));
    assert!(!keeps("https://pier-other.example.com/app/"));
    assert!(!keeps("mailto:a@example.com"));
    assert!(!keeps("file:///etc/passwd"));
}

#[test]
fn a_default_port_is_the_same_origin() {
    let (instance, _) = Instance::parse("https://pier.example.com").unwrap();
    assert!(instance.keeps(&Url::parse("https://pier.example.com:443/app/").unwrap()));
    assert!(!instance.keeps(&Url::parse("https://pier.example.com.evil.example/app/").unwrap()));
}

/// The pattern `mount` grants the instance's commands to: an IPC call's `Origin` header.
#[test]
fn the_ipc_grant_matches_only_the_instance_origin() {
    use tauri::utils::acl::RemoteUrlPattern;
    for (input, own, foreign) in [
        (
            "http://127.0.0.1:3142/login/tok",
            "http://127.0.0.1:3142",
            ["http://127.0.0.1:3143", "https://127.0.0.1:3142"],
        ),
        (
            "https://pier.example.com/app/",
            "https://pier.example.com",
            ["https://pier.example.com:8443", "http://pier.example.com"],
        ),
    ] {
        let (instance, _) = Instance::parse(input).unwrap();
        let pattern: RemoteUrlPattern = instance.url.parse().unwrap();
        let test = |url: &str| pattern.test(&Url::parse(url).unwrap());
        assert!(test(own), "{own}");
        assert!(test(&format!("{own}/app/")), "{own}/app/");
        for url in foreign.into_iter().chain(["https://evil.example", "https://pier.example.com.evil.example"]) {
            assert!(!test(url), "{url} matched {}", instance.url);
        }
    }
}
