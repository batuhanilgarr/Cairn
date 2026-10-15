//! Secret values in the macOS Keychain instead of the git-ignored `.cairn/secrets.yaml`.
//!
//! The collection keeps a marker (`keychain:`) where the value would be; the value itself lives here, under
//! the service "Cairn" and an account that names the collection, environment file and variable. On other
//! platforms these commands report "not available" and the file keeps being used.

const SERVICE: &str = "Cairn";

/// Whether this build can use a system keychain.
#[tauri::command]
pub fn secret_available() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(target_os = "macos")]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("Keychain: {e}"))
}

/// Store (or replace) a secret.
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        entry(&account)?.set_password(&value).map_err(|e| format!("Couldn't save to the Keychain: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (account, value, SERVICE);
        Err("The system keychain isn't available on this platform.".into())
    }
}

/// Read a secret. `None` when there is no such entry.
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        match entry(&account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read the Keychain: {e}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Ok(None)
    }
}

/// Remove a secret. Removing one that doesn't exist is fine.
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match entry(&account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Couldn't remove it from the Keychain: {e}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_matches_the_platform() {
        assert_eq!(secret_available(), cfg!(target_os = "macos"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_say_so_instead_of_pretending() {
        assert!(secret_set("a".into(), "b".into()).is_err());
        assert_eq!(secret_get("a".into()).unwrap(), None);
        assert!(secret_delete("a".into()).is_ok());
    }

    /// Touches the real login keychain with a throwaway entry that it removes again:
    /// `cargo test --lib keychain_roundtrip -- --ignored`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let account = format!("cairn-test|{}|roundtrip", std::process::id());
        assert_eq!(secret_get(account.clone()).unwrap(), None);
        secret_set(account.clone(), "first value".into()).unwrap();
        assert_eq!(secret_get(account.clone()).unwrap().as_deref(), Some("first value"));
        secret_set(account.clone(), "second, with \"quotes\" and ünïcode".into()).unwrap();
        assert_eq!(secret_get(account.clone()).unwrap().as_deref(), Some("second, with \"quotes\" and ünïcode"));
        secret_delete(account.clone()).unwrap();
        assert_eq!(secret_get(account.clone()).unwrap(), None);
        secret_delete(account).unwrap(); // deleting twice is fine
    }
}
