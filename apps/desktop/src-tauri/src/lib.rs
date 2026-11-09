//! The Recueil desktop shell.
//!
//! One window. It opens on the connection page (`shell/connect.html`), which checks the configured
//! server and, when it answers, hands over to the bundled web client (`/`), which talks to that
//! server directly. Everything the window may ask of this process is the four commands below; the
//! capability file (`capabilities/main.json`) grants exactly those and nothing from Tauri's core.
//!
//! This is phase A of `docs/platform-roadmap.md`: a client of a server that runs elsewhere. Phase
//! B bundles and supervises the server as a sidecar so that the application also works on its own.

mod connection;
mod credentials;
mod settings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use connection::{classify_navigation, is_app_origin, normalise_server_url, Navigation, DEFAULT_SERVER_URL};

const MAIN_WINDOW: &str = "main";
const CONNECT_PAGE: &str = "shell/connect.html";
const MENU_CONNECTION: &str = "connection-settings";
const MENU_RECONNECT: &str = "reconnect";

/// The longest token accepted. Recueil's own tokens are far shorter; this only bounds what is
/// handed to the credential store.
const MAX_TOKEN_LENGTH: usize = 4096;

/// The token for one server and where it came from.
#[derive(Debug, Clone)]
struct TokenLookup {
    token: Option<String>,
    /// `none`, `stored` or `session`, as `ShellState::token`.
    source: &'static str,
    /// Why the credential store could not be asked, if it could not.
    problem: Option<String>,
}

#[derive(Debug)]
struct Inner {
    server_url: String,
    saved: bool,
    settings_problem: Option<String>,
    /// Tokens the credential store would not take, by server URL. Memory only, this session only.
    session_tokens: HashMap<String, String>,
    /// The last credential-store answer, for the server it was asked about. The connection page and
    /// the web client both ask on every start, and a store that is slow to answer — or that times
    /// out, as a Secret Service that is not running does — should cost that once, not every time.
    token_cache: Option<(String, TokenLookup)>,
}

#[derive(Clone)]
struct Shell {
    /// The credential-store service name: the application identifier.
    service: String,
    settings_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    /// Serialize credential-store IO and cache changes; always acquire before `inner`.
    credential_ops: Arc<Mutex<()>>,
    /// Serialize the settings file and selected-server update. Lock order: save, credential, inner.
    save_ops: Arc<Mutex<()>>,
}

/// What the connection page shows. Never carries the token itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellState {
    server_url: String,
    default_server_url: &'static str,
    /// False on the first run, and when the settings file could not be used.
    saved: bool,
    settings_problem: Option<String>,
    /// `none`, `stored` (in the system credential store) or `session` (memory only).
    token: &'static str,
    credential_store_problem: Option<String>,
}

/// What the web client is built from (`apps/web/src/host.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

impl Shell {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock cannot leave `Inner` half-written in a way that matters,
        // so a poisoned lock is recovered rather than propagated.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn server_url(&self) -> String {
        self.lock().server_url.clone()
    }

    /// The token for one server snapshot. May block on the credential store.
    fn token_for(&self, server_url: &str) -> TokenLookup {
        self.token_for_with(server_url, || credentials::read(&self.service, server_url))
    }

    fn token_for_with(
        &self,
        server_url: &str,
        read: impl FnOnce() -> Result<Option<String>, credentials::StoreError>,
    ) -> TokenLookup {
        let _operation = self.credential_ops.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let inner = self.lock();
            if let Some(token) = inner.session_tokens.get(server_url) {
                return TokenLookup { token: Some(token.clone()), source: "session", problem: None };
            }
            if let Some((cached_for, lookup)) = &inner.token_cache {
                if cached_for == server_url {
                    return lookup.clone();
                }
            }
        }
        let lookup = match read() {
            Ok(Some(token)) => TokenLookup { token: Some(token), source: "stored", problem: None },
            Ok(None) => TokenLookup { token: None, source: "none", problem: None },
            Err(problem) => {
                eprintln!("recueil-desktop: no system credential store: {problem}");
                TokenLookup { token: None, source: "none", problem: Some(problem.to_string()) }
            }
        };
        self.lock().token_cache = Some((server_url.to_owned(), lookup.clone()));
        lookup
    }

    fn state(&self) -> ShellState {
        let (server_url, saved, settings_problem) = {
            let inner = self.lock();
            (inner.server_url.clone(), inner.saved, inner.settings_problem.clone())
        };
        let lookup = self.token_for(&server_url);
        ShellState {
            server_url,
            default_server_url: DEFAULT_SERVER_URL,
            saved,
            settings_problem,
            token: lookup.source,
            credential_store_problem: lookup.problem,
        }
    }

    fn connection(&self) -> Connection {
        // Credential lookup can block while another command changes the server. Keep the
        // address and its token paired with the same snapshot throughout that lookup.
        let server_url = self.server_url();
        self.connection_for(server_url)
    }

    fn connection_for(&self, server_url: String) -> Connection {
        let lookup = self.token_for(&server_url);
        Connection { base_url: server_url, token: lookup.token }
    }

    fn forget_token_with(
        &self,
        server_url: &str,
        forget: impl FnOnce() -> Result<(), credentials::StoreError>,
    ) -> Result<(), String> {
        let _operation = self.credential_ops.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut inner = self.lock();
            inner.session_tokens.remove(server_url);
            inner.token_cache = None;
        }
        forget().map_err(|problem| format!(
            "The saved token could not be removed: {problem}. Check the system credential store and try again."
        ))
    }

    fn save_token_with(
        &self,
        server_url: &str,
        token: &str,
        write: impl FnOnce() -> Result<(), credentials::StoreError>,
    ) {
        let _operation = self.credential_ops.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let written = write();
        let mut inner = self.lock();
        match written {
            Ok(()) => {
                inner.session_tokens.remove(server_url);
                let lookup = TokenLookup { token: Some(token.to_owned()), source: "stored", problem: None };
                inner.token_cache = Some((server_url.to_owned(), lookup));
            }
            Err(problem) => {
                eprintln!("recueil-desktop: token kept for this session only: {problem}");
                inner.session_tokens.insert(server_url.to_owned(), token.to_owned());
            }
        }
    }

    fn save(&self, server_url: &str, token: Option<&str>, forget_token: bool) -> Result<ShellState, String> {
        self.save_with_settings(server_url, token, forget_token, settings::save)
    }

    fn save_with_settings(
        &self,
        server_url: &str,
        token: Option<&str>,
        forget_token: bool,
        persist: impl FnOnce(&std::path::Path, &settings::Settings) -> std::io::Result<()>,
    ) -> Result<ShellState, String> {
        let server_url = normalise_server_url(server_url).map_err(|problem| problem.to_string())?;
        let token = token.map(str::trim).filter(|token| !token.is_empty());
        if let Some(token) = token {
            if token.len() > MAX_TOKEN_LENGTH || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err("A token is a single word: no spaces, no line breaks.".into());
            }
        }

        // Keep persisted settings and the in-memory server in one ordered save operation.
        let _save = self.save_ops.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        persist(&self.settings_path, &settings::Settings { server_url: server_url.clone() }).map_err(
            |error| format!("The settings could not be saved to {}: {error}", self.settings_path.display()),
        )?;
        {
            let mut inner = self.lock();
            inner.server_url = server_url.clone();
            inner.saved = true;
            inner.settings_problem = None;
        }

        if forget_token {
            self.forget_token_with(&server_url, || credentials::forget(&self.service, &server_url))?;
        }
        if let Some(token) = token {
            self.save_token_with(&server_url, token, || credentials::write(&self.service, &server_url, token));
        }
        Ok(self.state())
    }
}

/* Commands: the whole of what the window may ask. ------------------------------------------- */

#[tauri::command]
async fn shell_state(shell: tauri::State<'_, Shell>) -> Result<ShellState, String> {
    let shell = shell.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shell.state())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn check_server_url(server_url: String) -> Result<String, String> {
    normalise_server_url(&server_url).map_err(|problem| problem.to_string())
}

#[tauri::command]
async fn save_connection(
    shell: tauri::State<'_, Shell>,
    server_url: String,
    token: Option<String>,
    forget_token: bool,
) -> Result<ShellState, String> {
    let shell = shell.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shell.save(&server_url, token.as_deref(), forget_token))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn connection(shell: tauri::State<'_, Shell>) -> Result<Connection, String> {
    let shell = shell.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shell.connection())
        .await
        .map_err(|error| error.to_string())
}

/* The window. -------------------------------------------------------------------------------- */

fn open_externally(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("recueil-desktop: could not open a {} link: {error}", url.scheme());
    }
}

fn build_main_window(app: &AppHandle, shell: Shell) -> tauri::Result<()> {
    // `tauri dev` serves the bundle from a development server of its own (http://localhost:1430)
    // unless told not to, and the window has to be allowed to stay on it. Release builds have none.
    let dev_origin = if tauri::is_dev() { app.config().build.dev_url.as_ref().map(Url::origin) } else { None };
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App(CONNECT_PAGE.into()))
        .title("Recueil")
        .inner_size(1280.0, 820.0)
        .min_inner_size(880.0, 560.0)
        // The web client handles its own drops, if any; the shell has no use for Tauri's.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let server = Url::parse(&shell.server_url()).ok();
            match classify_navigation(url, server.as_ref(), dev_origin.as_ref()) {
                Navigation::Allow => true,
                Navigation::OpenExternally => {
                    open_externally(url);
                    false
                }
                Navigation::Block => {
                    eprintln!("recueil-desktop: blocked a navigation to a {} URL", url.scheme());
                    false
                }
            }
        })
        .on_new_window(|url, _features| {
            if !is_app_origin(&url) && matches!(url.scheme(), "http" | "https" | "mailto") {
                open_externally(&url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                eprintln!("recueil-desktop: loaded {}", payload.url());
            }
        })
        .build()?;
    Ok(())
}

/// Send the window back to the connection page: to edit the settings, or to check again.
fn show_connection_page(app: &AppHandle, edit: bool) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
    let Ok(current) = window.url() else { return };
    let target = if edit { format!("/{CONNECT_PAGE}?edit") } else { format!("/{CONNECT_PAGE}") };
    if let Ok(url) = current.join(&target) {
        if let Err(error) = window.navigate(url) {
            eprintln!("recueil-desktop: could not open the connection page: {error}");
        }
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let settings = MenuItem::with_id(app, MENU_CONNECTION, "Connection settings…", true, Some("CmdOrCtrl+,"))?;
    let reconnect = MenuItem::with_id(app, MENU_RECONNECT, "Reconnect", true, Some("CmdOrCtrl+Shift+R"))?;
    let server = Submenu::with_items(app, "Server", true, &[&settings, &reconnect])?;
    // Before Window and Help, which the default menu always ends with.
    let position = menu.items()?.len().saturating_sub(2);
    menu.insert(&server, position)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_state, check_server_url, save_connection, connection])
        .setup(|app| {
            let settings_path = settings::path_in(&app.path().app_config_dir()?);
            let (server_url, saved, settings_problem) = match settings::load(&settings_path) {
                settings::Loaded::Absent => (DEFAULT_SERVER_URL.to_owned(), false, None),
                settings::Loaded::Present(settings) => (settings.server_url, true, None),
                settings::Loaded::Unusable(problem) => {
                    eprintln!("recueil-desktop: {problem}");
                    (DEFAULT_SERVER_URL.to_owned(), false, Some(problem))
                }
            };
            eprintln!(
                "recueil-desktop: server {server_url} ({})",
                if saved { "from the settings file" } else { "default" }
            );

            let shell = Shell {
                service: app.config().identifier.clone(),
                settings_path,
                credential_ops: Arc::new(Mutex::new(())),
                save_ops: Arc::new(Mutex::new(())),
                inner: Arc::new(Mutex::new(Inner {
                    server_url,
                    saved,
                    settings_problem,
                    session_tokens: HashMap::new(),
                    token_cache: None,
                })),
            };
            app.manage(shell.clone());
            build_main_window(app.handle(), shell)?;
            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == MENU_CONNECTION {
                show_connection_page(app, true);
            } else if event.id() == MENU_RECONNECT {
                show_connection_page(app, false);
            }
        })
        .run(tauri::generate_context!())
        .expect("the Recueil desktop shell failed to start");
}

#[cfg(test)]
mod shell_tests {
    use super::*;

    fn empty_shell() -> Shell {
        Shell {
            service: "test-unused-credential-store".into(),
            settings_path: PathBuf::new(),
            credential_ops: Arc::new(Mutex::new(())),
            save_ops: Arc::new(Mutex::new(())),
            inner: Arc::new(Mutex::new(Inner {
                server_url: "https://library.example.org".into(), saved: true,
                settings_problem: None, session_tokens: HashMap::new(), token_cache: None,
            })),
        }
    }

    #[test]
    fn concurrent_saves_keep_the_real_settings_file_and_selected_server_in_order() {
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        struct TemporaryDirectory(PathBuf);
        impl Drop for TemporaryDirectory {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let temporary = TemporaryDirectory(std::env::temp_dir().join(format!(
            "recueil-concurrent-save-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        )));
        let mut shell = empty_shell();
        shell.settings_path = temporary.0.join("settings.json");
        let first = "https://first.example.org";
        let second = "https://second.example.org";
        // Status responses use these synthetic session tokens, never the OS store.
        {
            let mut inner = shell.lock();
            inner.session_tokens.insert(first.into(), "first-token".into());
            inner.session_tokens.insert(second.into(), "second-token".into());
        }
        let (persisted_tx, persisted_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first_shell = shell.clone();
        let first_save = std::thread::spawn(move || first_shell.save_with_settings(first, None, false, |path, value| {
            settings::save(path, value)?;
            persisted_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        }));
        persisted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // A second save cannot enter the persistence/state gap of the first one.
        assert!(shell.save_ops.try_lock().is_err());
        let (started_tx, started_rx) = mpsc::channel();
        let second_shell = shell.clone();
        let second_save = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            second_shell.save(second, None, false)
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(first_save.join().unwrap().unwrap().server_url, first);
        assert_eq!(second_save.join().unwrap().unwrap().server_url, second);
        assert_eq!(shell.server_url(), second);
        match settings::load(&shell.settings_path) {
            settings::Loaded::Present(saved) => assert_eq!(saved.server_url, second),
            other => panic!("Expected final saved settings, got {other:?}"),
        }
        assert_eq!(std::fs::read_dir(&temporary.0).unwrap().count(), 1);
    }

    fn slow_lookup_then_mutate(save: bool) {
        use std::sync::mpsc;
        use std::time::Duration;
        let shell = empty_shell();
        let server = shell.server_url();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reader_shell = shell.clone();
        let reader_server = server.clone();
        let reader = std::thread::spawn(move || reader_shell.token_for_with(&reader_server, || {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(Some("old-token".into()))
        }));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // The old store read holds the operation lock, not the state lock.
        assert!(shell.credential_ops.try_lock().is_err());
        assert!(shell.lock().token_cache.is_none());
        let writer_shell = shell.clone();
        let writer_server = server.clone();
        let writer = std::thread::spawn(move || {
            if save {
                writer_shell.save_token_with(&writer_server, "new-token", || Ok(()));
            } else {
                writer_shell.forget_token_with(&writer_server, || Ok(())).unwrap();
            }
        });
        release_tx.send(()).unwrap();
        reader.join().unwrap();
        writer.join().unwrap();
        if save {
            let latest = shell.token_for_with(&server, || panic!("new token must stay cached"));
            assert_eq!(latest.token.as_deref(), Some("new-token"));
        } else {
            assert!(shell.lock().token_cache.is_none());
            assert!(shell.token_for_with(&server, || Ok(None)).token.is_none());
        }
    }

    #[test]
    fn a_pending_store_read_cannot_repopulate_a_forgotten_token() {
        slow_lookup_then_mutate(false);
    }

    #[test]
    fn a_pending_store_read_cannot_replace_a_newly_saved_token() {
        slow_lookup_then_mutate(true);
    }

    #[test]
    fn a_failed_credential_deletion_is_reported_and_session_copies_are_cleared() {
        let server = "https://library.example.org".to_owned();
        let shell = Shell {
            service: "test-unused-credential-store".into(),
            settings_path: PathBuf::new(),
            credential_ops: Arc::new(Mutex::new(())),
            save_ops: Arc::new(Mutex::new(())),
            inner: Arc::new(Mutex::new(Inner {
                server_url: server.clone(), saved: true, settings_problem: None,
                session_tokens: HashMap::from([(server.clone(), "session-token".into())]),
                token_cache: Some((server.clone(), TokenLookup {
                    token: Some("cached-token".into()), source: "stored", problem: None,
                })),
            })),
        };
        let result = shell.forget_token_with(&server, || {
            Err(credentials::StoreError::Unavailable("test store is locked".into()))
        });
        assert!(result.unwrap_err().contains("saved token could not be removed"));
        let inner = shell.lock();
        assert!(!inner.session_tokens.contains_key(&server));
        assert!(inner.token_cache.is_none());
    }

    #[test]
    fn switching_servers_during_lookup_keeps_the_original_address_and_token_paired() {
        let original = "https://first.example.org".to_owned();
        let replacement = "https://second.example.org".to_owned();
        let shell = Shell {
            service: "test-unused-credential-store".into(),
            settings_path: PathBuf::new(),
            credential_ops: Arc::new(Mutex::new(())),
            save_ops: Arc::new(Mutex::new(())),
            inner: Arc::new(Mutex::new(Inner {
                server_url: original.clone(), saved: false, settings_problem: None,
                session_tokens: HashMap::from([
                    (original.clone(), "first-token".into()),
                    (replacement.clone(), "second-token".into()),
                ]),
                token_cache: None,
            })),
        };
        let snapshot = shell.server_url();
        shell.lock().server_url = replacement.clone();
        let pending = shell.connection_for(snapshot);
        assert_eq!(pending.base_url, original);
        assert_eq!(pending.token.as_deref(), Some("first-token"));
        let next = shell.connection();
        assert_eq!(next.base_url, replacement);
        assert_eq!(next.token.as_deref(), Some("second-token"));
    }
}
