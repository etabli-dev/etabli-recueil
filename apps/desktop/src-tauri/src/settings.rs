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
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut body = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    body.push(b'\n');

    let temporary = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&body)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)
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
        assert!(!path.with_extension("json.tmp").exists());
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
