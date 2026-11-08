//! The API token, in the operating system's credential store.
//!
//! One entry per server address, under the application identifier as the service name, so that
//! switching between two servers does not hand one server's token to the other. When no credential
//! store answers — a Linux session without a Secret Service, a locked-down machine — a token the
//! user types is kept in memory for this session only and the shell says so. It is never written
//! to a file.
//!
//! Every function here blocks on the platform store (D-Bus on Linux), so callers run them off the
//! main thread.

/// What the store answered, reduced to what the shell has to tell the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No credential store is reachable. The message is the platform's own.
    Unavailable(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(detail) => write!(f, "{detail}"),
        }
    }
}

fn entry(service: &str, server_url: &str) -> Result<keyring::Entry, StoreError> {
    keyring::Entry::new(service, server_url).map_err(|error| StoreError::Unavailable(error.to_string()))
}

/// The stored token for `server_url`, if there is one.
pub fn read(service: &str, server_url: &str) -> Result<Option<String>, StoreError> {
    match entry(service, server_url)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(StoreError::Unavailable(error.to_string())),
    }
}

pub fn write(service: &str, server_url: &str, token: &str) -> Result<(), StoreError> {
    entry(service, server_url)?
        .set_password(token)
        .map_err(|error| StoreError::Unavailable(error.to_string()))
}

/// Remove the stored token. Removing one that is not there is not an error.
pub fn forget(service: &str, server_url: &str) -> Result<(), StoreError> {
    match entry(service, server_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(StoreError::Unavailable(error.to_string())),
    }
}
