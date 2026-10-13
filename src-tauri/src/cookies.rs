//! A persistent cookie jar shared by every request, with a manager the UI can list and edit.
//! Stored as JSON in the app's data folder; session-only cookies live in memory.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use cookie_store::CookieStore;
use reqwest::header::HeaderValue;
use serde::Serialize;

#[derive(Clone)]
pub struct Jar(Arc<Mutex<CookieStore>>);

static JAR: OnceLock<Jar> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn jar() -> Jar {
    JAR.get_or_init(|| Jar(Arc::new(Mutex::new(CookieStore::default())))).clone()
}

/// Load saved cookies and remember where to save them. Called once at startup.
#[allow(deprecated)]
pub fn init(path: PathBuf) {
    if let Ok(f) = std::fs::File::open(&path) {
        if let Ok(store) = CookieStore::load_json(std::io::BufReader::new(f)) {
            *jar().0.lock().unwrap() = store;
        }
    }
    let _ = PATH.set(path);
}

impl Jar {
    #[allow(deprecated)]
    fn persist(&self) {
        let Some(path) = PATH.get() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let store = self.0.lock().unwrap();
        let mut buf = Vec::new();
        if store.save_json(&mut buf).is_ok() {
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, buf).is_ok() {
                let _ = std::fs::rename(tmp, path);
            }
        }
    }
}

impl reqwest::cookie::CookieStore for Jar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &url::Url) {
        let mut changed = false;
        {
            let mut store = self.0.lock().unwrap();
            for h in headers {
                if let Ok(s) = h.to_str() {
                    changed |= store.parse(s, url).is_ok();
                }
            }
        }
        if changed {
            self.persist();
        }
    }

    fn cookies(&self, url: &url::Url) -> Option<HeaderValue> {
        let store = self.0.lock().unwrap();
        let s = store.get_request_values(url).map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
        if s.is_empty() {
            None
        } else {
            HeaderValue::from_str(&s).ok()
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    /// RFC 3339, or None for a session cookie
    pub expires: Option<String>,
}

pub fn list() -> Vec<CookieInfo> {
    let j = jar();
    let store = j.0.lock().unwrap();
    let mut out: Vec<CookieInfo> = store
        .iter_unexpired()
        .map(|c| CookieInfo {
            domain: String::from(&c.domain),
            path: String::from(&c.path),
            name: c.name().to_string(),
            value: c.value().to_string(),
            secure: c.secure().unwrap_or(false),
            http_only: c.http_only().unwrap_or(false),
            expires: match &c.expires {
                cookie_store::CookieExpiration::AtUtc(t) => t.format(&time::format_description::well_known::Rfc3339).ok(),
                cookie_store::CookieExpiration::SessionEnd => None,
            },
        })
        .collect();
    out.sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
    out
}

pub fn remove(domain: &str, path: &str, name: &str) {
    let j = jar();
    j.0.lock().unwrap().remove(domain, path, name);
    j.persist();
}

pub fn clear(domain: Option<&str>) {
    {
        let j = jar();
        let mut store = j.0.lock().unwrap();
        match domain {
            None => store.clear(),
            Some(d) => {
                let doomed: Vec<(String, String, String)> = store
                    .iter_any()
                    .filter(|c| String::from(&c.domain) == d)
                    .map(|c| (String::from(&c.domain), String::from(&c.path), c.name().to_string()))
                    .collect();
                for (dom, p, n) in doomed {
                    store.remove(&dom, &p, &n);
                }
            }
        }
    }
    jar().persist();
}

/// Add a cookie by hand, as if `Set-Cookie` had arrived from `https://<domain>/`.
pub fn add(domain: &str, path: &str, name: &str, value: &str) -> Result<(), String> {
    let host = domain.trim().trim_start_matches('.');
    let url = url::Url::parse(&format!("https://{host}/")).map_err(|e| format!("Invalid domain: {e}"))?;
    let header = format!("{name}={value}; Domain={host}; Path={}", if path.is_empty() { "/" } else { path });
    let j = jar();
    j.0.lock().unwrap().parse(&header, &url).map_err(|e| format!("Couldn't add the cookie: {e}"))?;
    j.persist();
    Ok(())
}

#[tauri::command]
pub fn cookies_list() -> Vec<CookieInfo> {
    list()
}
#[tauri::command]
pub fn cookies_delete(domain: String, path: String, name: String) {
    remove(&domain, &path, &name)
}
#[tauri::command]
pub fn cookies_clear(domain: Option<String>) {
    clear(domain.as_deref())
}
#[tauri::command]
pub fn cookies_add(domain: String, path: String, name: String, value: String) -> Result<(), String> {
    add(&domain, &path, &name, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{send_request, NetworkSettings, RequestSpec};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The jar is process-wide, so tests that touch it must not run at the same time.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn spec(url: &str, disabled: bool) -> RequestSpec {
        RequestSpec {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body: None, multipart: None, body_file: None,
            timeout_ms: Some(5000),
            insecure: false,
            follow_redirects: true,
            network: NetworkSettings { cookies_disabled: disabled, ..Default::default() },
        }
    }

    /// Serves `n` connections: the first sets a cookie, later ones echo the request head they received.
    async fn server(n: usize) -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            for i in 0..n {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let k = s.read(&mut buf).await.unwrap();
                let head = String::from_utf8_lossy(&buf[..k]).to_string();
                let (extra, body) = if i == 0 { ("Set-Cookie: sid=abc123; Path=/; HttpOnly\r\n".to_string(), "set".to_string()) } else { (String::new(), head) };
                let resp = format!("HTTP/1.1 200 OK\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                s.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        port
    }

    #[tokio::test]
    async fn cookies_persist_across_requests_and_can_be_managed() {
        let _g = serial();
        clear(None);
        let port = server(3).await;
        let url = format!("http://127.0.0.1:{port}/");

        send_request(spec(&url, false)).await.unwrap();
        let echoed = send_request(spec(&url, false)).await.unwrap().body.to_lowercase();
        assert!(echoed.contains("cookie: sid=abc123"), "cookie was not sent back: {echoed}");

        let all = list();
        let c = all.iter().find(|c| c.name == "sid").expect("cookie listed");
        assert_eq!((c.value.as_str(), c.path.as_str(), c.http_only), ("abc123", "/", true));
        assert!(c.expires.is_none()); // a session cookie

        // switched off: nothing is sent
        let echoed = send_request(spec(&url, true)).await.unwrap().body.to_lowercase();
        assert!(!echoed.contains("cookie:"), "cookies were sent while disabled: {echoed}");

        remove(&c.domain.clone(), &c.path.clone(), "sid");
        assert!(!list().iter().any(|c| c.name == "sid"));
    }

    #[test]
    fn cookies_can_be_added_and_cleared_per_domain() {
        let _g = serial();
        clear(None);
        add("api.example.com", "/v1", "token", "t1").unwrap();
        add("other.dev", "", "x", "y").unwrap();
        let all = list();
        assert!(all.iter().any(|c| c.domain == "api.example.com" && c.path == "/v1" && c.name == "token"));
        clear(Some("api.example.com"));
        let all = list();
        assert!(!all.iter().any(|c| c.domain == "api.example.com"));
        assert!(all.iter().any(|c| c.domain == "other.dev" && c.path == "/"));
        assert!(add("bad domain with spaces", "/", "a", "b").is_err());
        clear(None);
        assert!(list().is_empty());
    }
}
