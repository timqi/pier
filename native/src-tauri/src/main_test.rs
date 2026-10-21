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
    assert_eq!(judged(vec![]).as_deref(), Some("no answer within 0s"));
}

#[test]
fn a_finished_load_waits_only_its_grace() {
    let ((tx, rx), started) = (mpsc::channel(), Instant::now());
    tx.send(Probed::Loaded).unwrap();
    assert!(verdict(&rx, Duration::from_secs(5), GRACE).is_some());
    assert!(started.elapsed() < Duration::from_secs(1));
}
