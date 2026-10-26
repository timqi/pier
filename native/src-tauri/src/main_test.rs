use std::sync::mpsc;

use super::*;

const WAIT: Duration = Duration::from_millis(400);
const GRACE: Duration = Duration::from_millis(100);

fn judged(events: Vec<Probed>) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    for event in events {
        tx.send(event).unwrap();
    }
    verdict(&rx, WAIT, GRACE)
}

#[test]
fn a_pier_whose_title_follows_the_load_passes() {
    assert_eq!(judged(vec![Probed::Loaded, Probed::Title(String::new()), Probed::Title("Pier".into())]), None);
    assert_eq!(judged(vec![Probed::Title("Pier".into()), Probed::Loaded]), None);
}

#[test]
fn a_title_that_arrives_in_its_own_time_passes() {
    let (tx, rx) = mpsc::channel();
    tx.send(Probed::Loaded).unwrap();
    let late = std::thread::spawn(move || {
        std::thread::sleep(GRACE / 2);
        tx.send(Probed::Title("Pier".into())).unwrap();
    });
    assert_eq!(verdict(&rx, WAIT, GRACE), None);
    late.join().unwrap();
}

#[test]
fn anything_else_is_named() {
    let titled = judged(vec![Probed::Loaded, Probed::Title("Grafana".into())]);
    assert_eq!(titled.as_deref(), Some("its /login is titled \"Grafana\""));
    assert_eq!(judged(vec![Probed::Loaded]).as_deref(), Some("its /login has no title"));
    let away = Url::parse("https://sso.example.com/").unwrap();
    assert_eq!(judged(vec![Probed::Left(away)]).as_deref(), Some("it redirects to https://sso.example.com/"));
    assert!(judged(vec![]).is_some_and(|why| why.starts_with("no answer within ")));
}

#[test]
fn a_finished_load_waits_only_its_grace() {
    let ((tx, rx), started) = (mpsc::channel(), Instant::now());
    tx.send(Probed::Loaded).unwrap();
    assert!(verdict(&rx, Duration::from_secs(5), GRACE).is_some());
    assert!(started.elapsed() < Duration::from_secs(1));
}

fn active() -> Option<String> {
    Some("a1".into())
}

#[test]
fn reload_instance_reloads_the_active_tab() {
    assert_eq!(reloads("reload", active).as_deref(), Some("a1"));
    assert_eq!(reloads("reload-f5", active).as_deref(), Some("a1"));
    assert_eq!(reloads("reload", || None), None);
}

#[test]
fn a_tab_menu_reload_reloads_its_own_tab() {
    assert_eq!(reloads("reload:b2", active).as_deref(), Some("b2"));
    assert_eq!(reloads("reload:b2", || None).as_deref(), Some("b2"));
}

#[test]
fn other_items_reload_nothing_nor_read_the_active_tab() {
    for item in ["add", "prev", "next", "nth-1", "reloaded"] {
        assert_eq!(reloads(item, || panic!("{item} read the active tab")), None, "{item}");
    }
}

#[test]
fn an_accent_in_either_theme_picks_its_preset() {
    let pairs = [
        ("#0066df", "indigo"),
        ("#499fff", "indigo"),
        ("#037f75", "teal"),
        ("#03b7a8", "teal"),
        ("#028355", "emerald"),
        ("#b17000", "amber"),
        ("#d98b03", "amber"),
        ("#c51b53", "rose"),
        ("#7a49d3", "violet"),
    ];
    for (hex, preset) in pairs {
        assert_eq!(accent_of(Some(hex)).2, preset, "{hex}");
    }
    assert_eq!(accent_of(None).2, "indigo");
    assert_eq!(accent_of(Some("#808080")).2, "indigo");
}
