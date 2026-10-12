use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
    pub insecure: bool,
    pub follow_redirects: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub size_bytes: usize,
    pub time_ms: u128,
    pub http_version: String,
}

#[tauri::command]
async fn send_request(spec: RequestSpec) -> Result<ResponseData, String> {
    let method = reqwest::Method::from_bytes(spec.method.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid method: {e}"))?;

    let redirect = if spec.follow_redirects {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(spec.insecure)
        .redirect(redirect)
        .timeout(Duration::from_millis(spec.timeout_ms.unwrap_or(30_000)))
        .user_agent(concat!("Reqnest/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.request(method, &spec.url);
    for (k, v) in spec.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(body) = spec.body.filter(|b| !b.is_empty()) {
        req = req.body(body);
    }

    let started = Instant::now();
    let res = req.send().await.map_err(describe_error)?;

    let status = res.status();
    let http_version = format!("{:?}", res.version());
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let bytes = res.bytes().await.map_err(describe_error)?;
    let time_ms = started.elapsed().as_millis();

    Ok(ResponseData {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        size_bytes: bytes.len(),
        body: String::from_utf8_lossy(&bytes).to_string(),
        time_ms,
        http_version,
    })
}

/// Wait for the OAuth redirect on http://127.0.0.1:<port>/callback and return its query string.
/// Loopback only, handles one successful callback, gives up after `timeout_secs`.
#[tauri::command]
async fn oauth_listen(port: u16, timeout_secs: u64) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Can't listen on 127.0.0.1:{port} for the OAuth redirect ({e}). Is another app using that port? Change the redirect port in the auth settings."))?;

    let wait = async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
            let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
            if path != "/callback" || query.is_empty() {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue; // favicon and other noise
            }
            let ok = !query.split('&').any(|kv| kv.starts_with("error="));
            let page = format!(
                "<!doctype html><meta charset=utf-8><title>Reqnest</title><body style=\"font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#17171a;color:#ececf1\"><div style=\"text-align:center\"><div style=\"font-size:42px;color:#8b74ff\">&#9670;</div><h2>{}</h2><p style=\"color:#8e8e99\">You can close this tab and return to Reqnest.</p></div>",
                if ok { "Signed in" } else { "Sign-in failed" }
            );
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", page.len(), page);
            let _ = stream.write_all(resp.as_bytes()).await;
            return Ok::<String, String>(query.to_string());
        }
    };
    tokio::time::timeout(Duration::from_secs(timeout_secs), wait)
        .await
        .map_err(|_| "Timed out waiting for the browser sign-in to finish".to_string())?
}

fn describe_error(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(&format!(": {s}"));
        src = s.source();
    }
    msg
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

fn read_tree(dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut nodes = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if !is_dir && !(name.ends_with(".req.yaml") || name.ends_with(".req.yml")) {
            continue;
        }
        let children = if is_dir { read_tree(&path)? } else { Vec::new() };
        nodes.push(TreeNode { name, path: path.to_string_lossy().to_string(), is_dir, children });
    }
    // Folders first, then alphabetical (case-insensitive): order comes from file names, never from file contents.
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

#[tauri::command]
fn list_tree(root: String) -> Result<Vec<TreeNode>, String> {
    read_tree(Path::new(&root))
}

#[tauri::command]
fn list_files(dir: String, suffix: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(&suffix) && !n.starts_with('.') {
                out.push(e.path().to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

fn walk_files(dir: &Path, suffix: &str, out: &mut Vec<String>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || n == "node_modules" {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                walk_files(&p, suffix, out);
            } else if n.ends_with(suffix) {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
}

#[tauri::command]
fn list_files_recursive(dir: String, suffix: String) -> Vec<String> {
    let mut out = Vec::new();
    walk_files(Path::new(&dir), &suffix, &mut out);
    out.sort();
    out
}

#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// Atomic write: temp file + rename, so a crash never leaves a half-written request.
#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp-reqnest");
    fs::write(&tmp, content).map_err(|e| format!("{path}: {e}"))?;
    fs::rename(&tmp, p).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("A file or folder with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| format!("{from}: {e}"))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            send_request,
            oauth_listen,
            list_tree,
            list_files,
            list_files_recursive,
            read_text,
            write_text,
            make_dir,
            remove_path,
            rename_path,
            path_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("reqnest-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().to_string()
    }

    #[test]
    fn tree_lists_only_requests_sorted_with_folders_first() {
        let root = tmp("tree");
        write_text(format!("{root}/b.req.yaml"), "name: b".into()).unwrap();
        write_text(format!("{root}/A.req.yaml"), "name: a".into()).unwrap();
        write_text(format!("{root}/notes.txt"), "x".into()).unwrap();
        write_text(format!("{root}/.reqnest/secrets.yaml"), "x".into()).unwrap();
        write_text(format!("{root}/users/get.req.yaml"), "name: g".into()).unwrap();
        let t = list_tree(root).unwrap();
        let names: Vec<_> = t.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["users", "A.req.yaml", "b.req.yaml"]);
        assert_eq!(t[0].children.len(), 1);
    }

    #[test]
    fn write_is_atomic_rename_refuses_overwrite_remove_works() {
        let root = tmp("fs");
        let f = format!("{root}/x.req.yaml");
        write_text(f.clone(), "1".into()).unwrap();
        write_text(f.clone(), "2".into()).unwrap();
        assert_eq!(read_text(f.clone()).unwrap().as_deref(), Some("2"));
        assert!(!Path::new(&format!("{root}/x.req.tmp-reqnest")).exists());
        write_text(format!("{root}/y.req.yaml"), "y".into()).unwrap();
        assert!(rename_path(f.clone(), format!("{root}/y.req.yaml")).is_err());
        remove_path(f.clone()).unwrap();
        assert_eq!(read_text(f).unwrap(), None);
    }
}

#[cfg(test)]
mod oauth_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn get(port: u16, path: &str) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn callback_ignores_noise_and_returns_query() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let task = tokio::spawn(oauth_listen(port, 5));
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(get(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let page = get(port, "/callback?code=abc&state=xyz").await;
        assert!(page.contains("Signed in"));
        assert_eq!(task.await.unwrap().unwrap(), "code=abc&state=xyz");
    }

    #[tokio::test]
    async fn callback_times_out() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let err = oauth_listen(port, 1).await.unwrap_err();
        assert!(err.contains("Timed out"));
    }
}
