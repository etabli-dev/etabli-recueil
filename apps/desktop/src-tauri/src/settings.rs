//! The shell's settings file: the server address and nothing else.
//!
//! It lives in the per-user configuration directory the operating system names for this
//! application (`$XDG_CONFIG_HOME/<identifier>` on Linux, `~/Library/Application Support/<identifier>`
//! on macOS, `%APPDATA%\<identifier>` on Windows). It never holds a credential: the API token, when
//! there is one, is in the system credential store (`credentials.rs`), and an address carrying a
//! user name or password is refused before it gets here (`connection.rs`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::connection::normalise_server_url;

pub const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The server's base URL, as `normalise_server_url` returns it.
    pub server_url: String,
}

/// What reading the settings file produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    /// No file yet: the first run.
    Absent,
    Present(Settings),
    /// A file that could not be used. The message names the file and says why; the shell falls
    /// back to the default address and says so rather than silently overwriting the file.
    Unusable(String),
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub fn load(path: &Path) -> Loaded {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Loaded::Absent,
        Err(error) => return Loaded::Unusable(format!("{} could not be read: {error}", path.display())),
    };
    let settings: Settings = match serde_json::from_str(&text) {
        Ok(settings) => settings,
        Err(error) => {
            return Loaded::Unusable(format!("{} is not valid settings JSON: {error}", path.display()))
        }
    };
    // The file is checked on the way in as well as on the way out: it is a file in a user
    // directory, and anything may have written it.
    match normalise_server_url(&settings.server_url) {
        Ok(server_url) => Loaded::Present(Settings { server_url }),
        Err(problem) => Loaded::Unusable(format!("{} names a server this shell refuses: {problem}", path.display())),
    }
}

/// Write the settings atomically: a sibling temporary file, flushed, then renamed over the old one,
/// so that a crash mid-write leaves either the old file or the new one and never half of each.
/// Exclusive temporary creation avoids collisions between saves or separate app instances.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut body = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    body.push(b'\n');

    static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);
    let (temporary, mut file) = loop {
        let mut name = path.file_name().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Settings path needs a file name")
        })?.to_os_string();
        name.push(format!(".tmp-{}-{}", std::process::id(), NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)));
        let temporary = path.with_file_name(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&temporary) {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let written = file.write_all(&body).and_then(|_| file.sync_all());
    // Windows cannot replace an open file; close it before rename or cleanup.
    drop(file);
    let result = written.and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recueil-desktop-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_missing_file_is_the_first_run() {
        let dir = scratch("absent");
        assert_eq!(load(&path_in(&dir)), Loaded::Absent);
    }

    #[test]
    fn saves_and_reads_back_only_the_address() {
        let dir = scratch("round-trip");
        let path = path_in(&dir);
        let settings = Settings { server_url: "https://library.example.org".into() };
        save(&path, &settings).unwrap();

        assert_eq!(load(&path), Loaded::Present(settings));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "{\n  \"serverUrl\": \"https://library.example.org\"\n}\n");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "No temporary files remain");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_direct_saves_do_not_share_a_temporary_file() {
        use std::sync::{Arc, Barrier};
        let dir = scratch("concurrent");
        let path = path_in(&dir);
        let barrier = Arc::new(Barrier::new(8));
        let writers: Vec<_> = (0..8).map(|index| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let settings = Settings { server_url: format!("https://server-{index}.example.org") };
                barrier.wait();
                for _ in 0..8 { save(&path, &settings).unwrap(); }
            })
        }).collect();
        for writer in writers { writer.join().unwrap(); }
        let Loaded::Present(saved) = load(&path) else { panic!("Final settings must be valid JSON") };
        assert!((0..8).any(|index| saved.server_url == format!("https://server-{index}.example.org")));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "No temporary files remain");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_replacement_removes_only_its_own_temporary_file() {
        let dir = scratch("failed-replacement");
        let path = path_in(&dir);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("keep.txt"), "original").unwrap();
        let settings = Settings { server_url: "https://library.example.org".into() };
        assert!(save(&path, &settings).is_err());
        assert_eq!(fs::read_to_string(path.join("keep.txt")).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "No temporary file remains after error");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_or_refused_file_is_reported_not_trusted() {
        let dir = scratch("damaged");
        let path = path_in(&dir);
        fs::create_dir_all(&dir).unwrap();

        fs::write(&path, "{ not json").unwrap();
        assert!(matches!(load(&path), Loaded::Unusable(message) if message.contains("not valid settings JSON")));

        fs::write(&path, r#"{"serverUrl":"http://192.168.1.20:3000"}"#).unwrap();
        assert!(matches!(load(&path), Loaded::Unusable(message) if message.contains("refuses")));

        fs::write(&path, r#"{"serverUrl":"https://user:pw@example.org"}"#).unwrap();
        assert!(matches!(load(&path), Loaded::Unusable(_)));
        fs::remove_dir_all(dir).unwrap();
    }
}
