//! The instance list on disk: `pier-client/instances.json` in the platform config dir.

use std::{
    fs,
    hash::{BuildHasher, RandomState},
    io,
    path::Path,
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use tauri::Url;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Instance {
    /// `i-` and 32 hex digits: the webview label and the key of its data store.
    pub id: String,
    pub name: String,
    /// The origin; the webview loads `<url>/app/`.
    pub url: String,
    /// The user named it, so the page title no longer does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
    /// Its tab is closed: listed, its data kept, no webview.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
}

impl Instance {
    /// From what the user pasted, with the URL its webview loads first: a
    /// `pier login` link signs in on its way to `/app/`.
    pub fn parse(input: &str) -> Result<(Self, Url), String> {
        let input = input.trim();
        let link = Url::parse(input).map_err(|e| format!("not a URL ({e}): {input}"))?;
        if !matches!(link.scheme(), "http" | "https") || link.host_str().is_none() {
            return Err(format!("not an http(s) URL: {input}"));
        }
        let url = link.origin().ascii_serialization();
        let first = if link.path().starts_with("/login/") { link } else { app_url(&url)? };
        let instance = Self { id: new_id(), name: host(&url), url, named: false, closed: false };
        Ok((instance, first))
    }

    pub fn app_url(&self) -> Result<Url, String> {
        app_url(&self.url)
    }

    /// Whether its tab loads `url`: its own origin (scheme, host and port) or a frame with
    /// no origin to leave to; every other page, another Pier's included, is the browser's.
    pub fn keeps(&self, url: &Url) -> bool {
        matches!(url.scheme(), "about" | "data") || url.origin().ascii_serialization() == self.url
    }
}

/// The name an instance has before its page reports a title.
pub fn host(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| url.to_owned())
}

fn app_url(origin: &str) -> Result<Url, String> {
    Url::parse(origin).and_then(|u| u.join("/app/")).map_err(|e| format!("{origin}: {e}"))
}

fn valid(instance: &Instance) -> bool {
    let id = instance.id.strip_prefix("i-");
    id.is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit())) && instance.app_url().is_ok()
}

fn new_id() -> String {
    let now = SystemTime::now();
    // Each RandomState carries fresh keys, so the two halves differ.
    let half = || u128::from(RandomState::new().hash_one(now));
    format!("i-{:032x}", half() << 64 | half())
}

/// A distinct WKWebsiteDataStore per instance: its own cookie jar.
#[cfg(target_os = "macos")]
pub fn store_key(id: &str) -> [u8; 16] {
    id.strip_prefix("i-").and_then(|hex| u128::from_str_radix(hex, 16).ok()).unwrap_or_default().to_be_bytes()
}

/// The stored list. A file that does not read as one is set aside as
/// `instances.json.bad`, so the next save cannot overwrite what it held.
pub fn load(path: &Path) -> Result<Vec<Instance>, String> {
    // Bytes, not a string: a file that is not UTF-8 is malformed and set aside too.
    let bytes = match fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        read => read.map_err(|e| format!("{}: {e}", path.display()))?,
    };
    let problem = match serde_json::from_slice::<Vec<Instance>>(&bytes) {
        Ok(all) if all.iter().all(valid) => return Ok(all),
        Ok(_) => "an entry with a malformed id or url".to_owned(),
        Err(e) => e.to_string(),
    };
    let bad = path.with_extension("json.bad");
    match fs::rename(path, &bad) {
        Ok(()) => Err(format!("{}: {problem}; set aside as {}", path.display(), bad.display())),
        Err(e) => Err(format!("{}: {problem}; setting it aside failed: {e}", path.display())),
    }
}

/// Written whole through a temporary file, so a crash leaves the old list or the new one.
pub fn save(path: &Path, all: &[Instance]) -> Result<(), String> {
    let write = || -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(all)?)?;
        fs::rename(&tmp, path)
    };
    write().map_err(|e| format!("saving {}: {e}", path.display()))
}

#[cfg(test)]
#[path = "store_test.rs"]
mod tests;
