//! Which server addresses the shell accepts, and where the window may navigate.
//!
//! Both rules are pure functions of their input so that they can be tested without a window, and
//! both are deliberately narrow. A server address is either HTTPS, or plain HTTP on the loopback
//! interface — anything else would send the library, and any token with it, across a network in
//! clear text, and the web view blocks it as mixed content anyway. The window shows the bundled
//! client and the configured server, and hands every other link to the system browser.

use std::net::IpAddr;

use url::{Host, Origin, Url};

/// Where `recueil serve` listens when nothing else is configured (`apps/server/src/config.ts`).
pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:3000";

/// Why an address was refused. Each message says what to type instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlProblem {
    Empty,
    NotAUrl,
    MissingScheme,
    UnsupportedScheme(String),
    CredentialsInUrl,
    QueryOrFragment,
    PlainHttpOffLoopback(String),
}

impl std::fmt::Display for UrlProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "Enter the address of a Recueil server."),
            Self::NotAUrl => write!(
                f,
                "That is not an address. Use the form http://127.0.0.1:3000 or https://library.example.org."
            ),
            Self::MissingScheme => write!(
                f,
                "Include the scheme: http://127.0.0.1:3000 on this computer, https://… for any other server."
            ),
            Self::UnsupportedScheme(scheme) => {
                write!(f, "Only http and https addresses are supported, not {scheme}.")
            }
            Self::CredentialsInUrl => write!(
                f,
                "Remove the user name and password from the address. A token goes in the token field, which is kept in the system credential store."
            ),
            Self::QueryOrFragment => write!(
                f,
                "Remove the part after ? or # — the address is the server's base URL only."
            ),
            Self::PlainHttpOffLoopback(host) => write!(
                f,
                "{host} is not this computer, so the connection has to be encrypted: use https://. Plain http is accepted for 127.0.0.1, ::1 and localhost only."
            ),
        }
    }
}

/// True for the hosts plain HTTP may be used with: the loopback addresses and `localhost`.
pub fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => IpAddr::V4(*address).is_loopback(),
        Host::Ipv6(address) => IpAddr::V6(*address).is_loopback(),
    }
}

/// Check a server address as typed and return it in canonical form, without a trailing slash.
///
/// A path is kept, because a reverse proxy may publish the server under one
/// (`https://example.org/recueil`); the client appends `/api/v1` and `/health` to whatever this
/// returns.
pub fn normalise_server_url(input: &str) -> Result<String, UrlProblem> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(UrlProblem::Empty);
    }
    if !trimmed.contains("://") {
        return Err(UrlProblem::MissingScheme);
    }
    let url = Url::parse(trimmed).map_err(|_| UrlProblem::NotAUrl)?;

    match url.scheme() {
        "http" | "https" => {}
        other => return Err(UrlProblem::UnsupportedScheme(other.to_owned())),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlProblem::CredentialsInUrl);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(UrlProblem::QueryOrFragment);
    }
    let host = url.host().ok_or(UrlProblem::NotAUrl)?;
    if url.scheme() == "http" && !is_loopback(&host) {
        return Err(UrlProblem::PlainHttpOffLoopback(host.to_string()));
    }

    let rendered = url.as_str().trim_end_matches('/').to_owned();
    Ok(rendered)
}

/// What the window does with a navigation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// The bundled client, or the configured server (the review pane embeds documents from it).
    Allow,
    /// A web or mail link: cancelled here and opened by the operating system instead.
    OpenExternally,
    /// Anything else — `file:`, `data:`, custom schemes. Cancelled and not opened.
    Block,
}

/// True when `url` is the shell's own origin: `tauri://localhost` on Linux and macOS,
/// `http://tauri.localhost` on Windows.
pub fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Decide a navigation. `server` is the configured server's base URL, if one is known; `dev` is
/// the origin of `tauri dev`'s own development server, in a development build only.
pub fn classify_navigation(target: &Url, server: Option<&Url>, dev: Option<&Origin>) -> Navigation {
    if is_app_origin(target) || target.as_str() == "about:blank" {
        return Navigation::Allow;
    }
    if dev.is_some_and(|dev| *dev == target.origin()) {
        return Navigation::Allow;
    }
    if let Some(server) = server {
        if target.origin() == server.origin() {
            return Navigation::Allow;
        }
    }
    match target.scheme() {
        "http" | "https" | "mailto" => Navigation::OpenExternally,
        _ => Navigation::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_http_and_strips_the_trailing_slash() {
        assert_eq!(normalise_server_url("http://127.0.0.1:3000/").unwrap(), "http://127.0.0.1:3000");
        assert_eq!(normalise_server_url("  http://localhost:3000 ").unwrap(), "http://localhost:3000");
        assert_eq!(normalise_server_url("http://127.0.0.2:8080").unwrap(), "http://127.0.0.2:8080");
        assert_eq!(normalise_server_url("http://[::1]:3000").unwrap(), "http://[::1]:3000");
        assert_eq!(normalise_server_url(DEFAULT_SERVER_URL).unwrap(), DEFAULT_SERVER_URL);
    }

    #[test]
    fn accepts_https_anywhere_and_keeps_a_path_prefix() {
        assert_eq!(
            normalise_server_url("https://library.example.org").unwrap(),
            "https://library.example.org"
        );
        assert_eq!(
            normalise_server_url("https://example.org/recueil/").unwrap(),
            "https://example.org/recueil"
        );
        assert_eq!(normalise_server_url("HTTPS://Example.ORG:8443").unwrap(), "https://example.org:8443");
    }

    #[test]
    fn refuses_plain_http_off_loopback() {
        assert_eq!(
            normalise_server_url("http://192.168.1.20:3000"),
            Err(UrlProblem::PlainHttpOffLoopback("192.168.1.20".into()))
        );
        assert_eq!(
            normalise_server_url("http://library.example.org"),
            Err(UrlProblem::PlainHttpOffLoopback("library.example.org".into()))
        );
        // `localhost.example.org` is not `localhost`.
        assert!(normalise_server_url("http://localhost.example.org").is_err());
    }

    #[test]
    fn refuses_what_would_put_a_credential_or_a_guess_into_the_settings() {
        assert_eq!(normalise_server_url(""), Err(UrlProblem::Empty));
        assert_eq!(normalise_server_url("127.0.0.1:3000"), Err(UrlProblem::MissingScheme));
        assert_eq!(normalise_server_url("library.example.org"), Err(UrlProblem::MissingScheme));
        assert_eq!(
            normalise_server_url("https://user:secret@example.org"),
            Err(UrlProblem::CredentialsInUrl)
        );
        assert_eq!(normalise_server_url("https://user@example.org"), Err(UrlProblem::CredentialsInUrl));
        assert_eq!(
            normalise_server_url("https://example.org/?token=abc"),
            Err(UrlProblem::QueryOrFragment)
        );
        assert_eq!(normalise_server_url("https://example.org/#x"), Err(UrlProblem::QueryOrFragment));
        assert_eq!(
            normalise_server_url("ftp://example.org"),
            Err(UrlProblem::UnsupportedScheme("ftp".into()))
        );
        assert_eq!(
            normalise_server_url("file:///etc/passwd"),
            Err(UrlProblem::UnsupportedScheme("file".into()))
        );
    }

    #[test]
    fn every_problem_has_a_message() {
        for problem in [
            UrlProblem::Empty,
            UrlProblem::NotAUrl,
            UrlProblem::MissingScheme,
            UrlProblem::UnsupportedScheme("ftp".into()),
            UrlProblem::CredentialsInUrl,
            UrlProblem::QueryOrFragment,
            UrlProblem::PlainHttpOffLoopback("example.org".into()),
        ] {
            assert!(problem.to_string().len() > 20);
        }
    }

    #[test]
    fn navigation_stays_on_the_app_and_the_configured_server() {
        let server = Url::parse("http://127.0.0.1:3000").unwrap();
        let allow = |target: &str| classify_navigation(&Url::parse(target).unwrap(), Some(&server), None);

        assert_eq!(allow("tauri://localhost/shell/connect.html"), Navigation::Allow);
        assert_eq!(allow("http://tauri.localhost/reader/abc"), Navigation::Allow);
        assert_eq!(allow("about:blank"), Navigation::Allow);
        assert_eq!(allow("http://127.0.0.1:3000/api/v1/documents/x/content"), Navigation::Allow);

        assert_eq!(allow("http://127.0.0.1:3001/"), Navigation::OpenExternally);
        assert_eq!(allow("https://doi.org/10.1000/182"), Navigation::OpenExternally);
        assert_eq!(allow("mailto:someone@example.org"), Navigation::OpenExternally);

        assert_eq!(allow("file:///etc/passwd"), Navigation::Block);
        assert_eq!(allow("data:text/html,hello"), Navigation::Block);
        assert_eq!(allow("tauri://evil.example/"), Navigation::Block);
        assert_eq!(allow("javascript:alert(1)"), Navigation::Block);
    }

    #[test]
    fn without_a_server_only_the_app_is_allowed() {
        let target = Url::parse("http://127.0.0.1:3000/").unwrap();
        assert_eq!(classify_navigation(&target, None, None), Navigation::OpenExternally);
    }

    #[test]
    fn a_development_server_is_the_app_only_when_named() {
        let page = Url::parse("http://localhost:1430/shell/connect.html").unwrap();
        let dev = Url::parse("http://localhost:1430").unwrap().origin();
        assert_eq!(classify_navigation(&page, None, Some(&dev)), Navigation::Allow);
        assert_eq!(classify_navigation(&page, None, None), Navigation::OpenExternally);
    }
}
