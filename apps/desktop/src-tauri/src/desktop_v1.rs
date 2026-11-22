//! Desktop v1 (platform roadmap PM7): the tray icon, `recueil://` links and "Watch a folder…".
//!
//! Everything here runs in this process; the web view is granted no new permission. A link or a
//! menu choice ends as a navigation of the main window to a route of the web client, which does
//! the rest with its own API client:
//!
//! - `recueil://item/<id>` → `/?item=<id>`, the library with that item selected;
//! - `recueil://capture` → `/capture`;
//! - "Watch a folder…" → `/sources?folder=<path>`, a new folder source with the path filled in.
//!   That only makes sense for a server on this computer — the server watches the folder — and the
//!   Sources form says so.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

pub const MENU_WATCH_FOLDER: &str = "watch-folder";
const TRAY_SHOW: &str = "tray-show";
const TRAY_CAPTURE: &str = "tray-capture";
const TRAY_QUIT: &str = "tray-quit";

/// A ULID, the shape of every Recueil id: 26 characters of Crockford base 32.
fn is_record_id(value: &str) -> bool {
    value.len() == 26 && value.bytes().all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U')))
}

/// The web client route a `recueil://` link opens, or `None` for a link this build does not know.
pub fn deep_link_route(url: &Url) -> Option<String> {
    if url.scheme() != "recueil" {
        return None;
    }
    // `recueil://item/<id>` parses with `item` as the host and `/<id>` as the path.
    let host = url.host_str().unwrap_or("");
    let segments: Vec<&str> = url.path().split('/').filter(|part| !part.is_empty()).collect();
    match (host, segments.as_slice()) {
        ("item", [id]) if is_record_id(id) => Some(format!("/?item={id}")),
        ("capture", []) => Some("/capture".to_owned()),
        _ => None,
    }
}

/// `/sources?folder=<path>`, the path percent-encoded.
pub fn watch_folder_route(path: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    format!("/sources?folder={encoded}")
}

/// Bring the main window forward and, given a route, open it — once the web client is loaded.
pub fn show(app: &AppHandle, route: Option<&str>) {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let Some(route) = route else { return };
    let Ok(current) = window.url() else { return };
    // Before the connection page has handed over, the web client is not there to take the route.
    if current.path().starts_with("/shell/") {
        eprintln!("recueil-desktop: connect to a server first; {route} was not opened");
        return;
    }
    if let Ok(target) = current.join(route) {
        if let Err(error) = window.navigate(target) {
            eprintln!("recueil-desktop: could not open {route}: {error}");
        }
    }
}

pub fn open_links(app: &AppHandle, urls: &[Url]) {
    for url in urls {
        match deep_link_route(url) {
            Some(route) => show(app, Some(&route)),
            None => eprintln!("recueil-desktop: ignored a link this build does not know: {}", url.scheme()),
        }
    }
}

pub fn pick_watch_folder(app: &AppHandle) {
    let handle = app.clone();
    app.dialog().file().set_title("Watch a folder").pick_folder(move |picked| {
        let Some(picked) = picked else { return };
        match picked.into_path() {
            Ok(path) => show(&handle, Some(&watch_folder_route(&path.to_string_lossy()))),
            Err(error) => eprintln!("recueil-desktop: the picked folder has no local path: {error}"),
        }
    });
}

/// Menu choices this module owns; `true` when it handled the id.
pub fn handle_menu(app: &AppHandle, id: &str) -> bool {
    match id {
        TRAY_SHOW => show(app, None),
        TRAY_CAPTURE => show(app, Some("/capture")),
        MENU_WATCH_FOLDER => pick_watch_folder(app),
        TRAY_QUIT => app.exit(0),
        _ => return false,
    }
    true
}

/// The tray icon and its menu, and the link handler: called once from `setup`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW, "Show Recueil", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, TRAY_CAPTURE, "Capture…", true, None::<&str>)?;
    let watch = MenuItem::with_id(app, MENU_WATCH_FOLDER, "Watch a folder…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit Recueil", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &capture, &watch, &separator, &quit])?;
    // The tray menu's choices reach the application's one menu handler (`handle_menu`), the same
    // as the window menu's, so "Watch a folder…" opens one picker whichever menu it came from.
    let mut tray = TrayIconBuilder::with_id("recueil").tooltip("Recueil").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // Links the application was started with, then links that arrive while it runs.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        open_links(app, &urls);
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| open_links(&handle, &event.urls()));
    // An AppImage or a development build is not installed, so its scheme is registered at run time.
    #[cfg(any(target_os = "linux", windows))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("recueil-desktop: could not register the recueil:// scheme: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_links_open_the_item_and_nothing_else_gets_through() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert_eq!(deep_link_route(&url("recueil://item/01JD3X8Q7V5ZKM2N4P6R8T0W2Y")).as_deref(), Some("/?item=01JD3X8Q7V5ZKM2N4P6R8T0W2Y"));
        assert_eq!(deep_link_route(&url("recueil://capture")).as_deref(), Some("/capture"));
        assert_eq!(deep_link_route(&url("recueil://item/not-an-id")), None);
        assert_eq!(deep_link_route(&url("recueil://item/01JD3X8Q7V5ZKM2N4P6R8T0W2Y/extra")), None);
        assert_eq!(deep_link_route(&url("recueil://settings")), None);
        assert_eq!(deep_link_route(&url("https://item/01JD3X8Q7V5ZKM2N4P6R8T0W2Y")), None);
    }

    #[test]
    fn a_picked_folder_is_percent_encoded_into_the_sources_route() {
        assert_eq!(watch_folder_route("/home/ada/Scans & Notes"), "/sources?folder=%2Fhome%2Fada%2FScans+%26+Notes");
        assert_eq!(watch_folder_route("C:\\Users\\Ada\\Scans"), "/sources?folder=C%3A%5CUsers%5CAda%5CScans");
    }
}
