use serde::{Deserialize, Serialize};
pub mod cookies;
pub mod grpc;
pub mod mcp;
pub mod mock;
pub mod streams;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// multipart/form-data fields. When set, `body` is ignored and the Content-Type (with boundary) is generated here.
    #[serde(default)]
    pub multipart: Option<Vec<MultipartPart>>,
    /// Send this file's bytes as the raw request body.
    #[serde(default)]
    pub body_file: Option<String>,
    pub timeout_ms: Option<u64>,
    pub insecure: bool,
    pub follow_redirects: bool,
    #[serde(default)]
    pub network: NetworkSettings,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    pub name: String,
    /// Text value, or the file path when `file` is set.
    pub value: String,
    #[serde(default)]
    pub file: bool,
    #[serde(default)]
    pub content_type: Option<String>,
}

fn quote_param(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace(['\r', '\n'], " ")
}

/// Encode parts as multipart/form-data. Returns the body and the Content-Type header value.
pub(crate) fn build_multipart(parts: &[MultipartPart]) -> Result<(Vec<u8>, String), String> {
    let boundary = format!("----ReqnestBoundary{:032x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut out: Vec<u8> = Vec::new();
    for p in parts {
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        if p.file {
            let path = Path::new(&p.value);
            let bytes = fs::read(path).map_err(|e| format!("Can't read file for field \"{}\" ({}): {e}", p.name, p.value))?;
            let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
            let ct = p.content_type.clone().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "application/octet-stream".into());
            out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {ct}\r\n\r\n", quote_param(&p.name), quote_param(&filename)).as_bytes());
            out.extend_from_slice(&bytes);
        } else {
            out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{}\"\r\n", quote_param(&p.name)).as_bytes());
            if let Some(ct) = p.content_type.as_ref().filter(|c| !c.trim().is_empty()) {
                out.extend_from_slice(format!("Content-Type: {ct}\r\n").as_bytes());
            }
            out.extend_from_slice(b"\r\n");
            out.extend_from_slice(p.value.as_bytes());
        }
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((out, format!("multipart/form-data; boundary={boundary}")))
}

/// App-wide network settings (Settings > Network). Sent with every request so the UI stays the single source of truth.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSettings {
    /// "env" (default: honour HTTP(S)_PROXY), "none", or "custom"
    pub proxy_mode: String,
    pub proxy_url: String,
    pub no_proxy: String,
    /// PEM file with extra trusted root certificates
    pub ca_cert: String,
    /// PEM client certificate + private key for mutual TLS
    pub client_cert: String,
    pub client_key: String,
    pub user_agent: String,
    /// Cookies are stored and sent automatically unless this is set.
    pub cookies_disabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Set instead of `body` for binary responses (images, PDFs, archives, anything that isn't valid UTF-8).
    pub body_base64: Option<String>,
    pub content_type: String,
    pub size_bytes: usize,
    pub time_ms: u128,
    /// Time until the response headers arrived.
    pub ttfb_ms: u128,
    pub http_version: String,
}

fn is_binary(content_type: &str, bytes: &[u8]) -> bool {
    let ct = content_type.to_lowercase();
    let texty = ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("xml")
        || ct.contains("javascript")
        || ct.contains("x-www-form-urlencoded")
        || ct.contains("graphql")
        || ct.contains("yaml")
        || ct.contains("csv");
    if texty {
        return false;
    }
    let declared_binary = ct.starts_with("image/") || ct.starts_with("audio/") || ct.starts_with("video/") || ct.starts_with("font/") || ct.contains("pdf") || ct.contains("octet-stream") || ct.contains("zip") || ct.contains("protobuf") || ct.contains("msgpack");
    declared_binary || std::str::from_utf8(bytes).is_err()
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

    let client = build_client(&spec, redirect, false)?;

    let mut req = client.request(method, &spec.url);
    let multipart = match &spec.multipart {
        Some(parts) => Some(build_multipart(parts)?),
        None => None,
    };
    for (k, v) in spec.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        if multipart.is_some() && k.eq_ignore_ascii_case("content-type") {
            continue; // the boundary lives in the generated header
        }
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some((bytes, content_type)) = multipart {
        req = req.header("Content-Type", content_type).body(bytes);
    } else if let Some(path) = spec.body_file.as_ref().filter(|p| !p.trim().is_empty()) {
        req = req.body(fs::read(path).map_err(|e| format!("Can't read body file {path}: {e}"))?);
    } else if let Some(body) = spec.body.filter(|b| !b.is_empty()) {
        req = req.body(body);
    }

    let started = Instant::now();
    let res = req.send().await.map_err(describe_error)?;
    let ttfb_ms = started.elapsed().as_millis();

    let status = res.status();
    let http_version = format!("{:?}", res.version());
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res.bytes().await.map_err(describe_error)?;
    let time_ms = started.elapsed().as_millis();

    let binary = !bytes.is_empty() && is_binary(&content_type, &bytes);
    let (body, body_base64) = if binary {
        use base64::Engine;
        (String::new(), Some(base64::engine::general_purpose::STANDARD.encode(&bytes)))
    } else {
        (String::from_utf8_lossy(&bytes).to_string(), None)
    };

    Ok(ResponseData {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        size_bytes: bytes.len(),
        body,
        body_base64,
        content_type,
        time_ms,
        ttfb_ms,
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

pub(crate) fn build_client(spec: &RequestSpec, redirect: reqwest::redirect::Policy, streaming: bool) -> Result<reqwest::Client, String> {
    let n = &spec.network;
    let ua = if n.user_agent.trim().is_empty() {
        concat!("Reqnest/", env!("CARGO_PKG_VERSION")).to_string()
    } else {
        n.user_agent.clone()
    };
    let mut b = reqwest::Client::builder()
        .danger_accept_invalid_certs(spec.insecure)
        .redirect(redirect)
        .user_agent(ua);
    // A stream is meant to stay open: only the connection attempt is time-limited, not the whole body.
    let limit = Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    b = if streaming { b.connect_timeout(limit) } else { b.timeout(limit) };

    if !n.cookies_disabled {
        b = b.cookie_provider(Arc::new(cookies::jar()));
    }

    match n.proxy_mode.as_str() {
        "none" => b = b.no_proxy(),
        "custom" if !n.proxy_url.trim().is_empty() => {
            let mut p = reqwest::Proxy::all(n.proxy_url.trim()).map_err(|e| format!("Invalid proxy URL: {e}"))?;
            if !n.no_proxy.trim().is_empty() {
                p = p.no_proxy(reqwest::NoProxy::from_string(n.no_proxy.trim()));
            }
            b = b.proxy(p);
        }
        _ => {} // default: environment proxies
    }
    if !n.ca_cert.trim().is_empty() {
        let pem = fs::read(n.ca_cert.trim()).map_err(|e| format!("CA certificate {}: {e}", n.ca_cert))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| format!("CA certificate {}: {e}", n.ca_cert))?;
        for c in certs {
            b = b.add_root_certificate(c);
        }
    }
    if !n.client_cert.trim().is_empty() {
        let mut pem = fs::read(n.client_cert.trim()).map_err(|e| format!("Client certificate {}: {e}", n.client_cert))?;
        if !n.client_key.trim().is_empty() {
            pem.push(b'\n');
            pem.extend(fs::read(n.client_key.trim()).map_err(|e| format!("Client key {}: {e}", n.client_key))?);
        }
        let id = reqwest::Identity::from_pem(&pem).map_err(|e| format!("Client certificate/key: {e}"))?;
        b = b.identity(id);
    }
    b.build().map_err(|e| e.to_string())
}

pub(crate) fn describe_error(e: reqwest::Error) -> String {
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

/// Save a response body chosen by the user in a save dialog. Accepts base64 (binary) or plain text.
#[tauri::command]
fn save_bytes(path: String, base64: Option<String>, text: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let bytes = match (base64, text) {
        (Some(b), _) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("Not valid base64: {e}"))?,
        (None, Some(t)) => t.into_bytes(),
        _ => return Err("Nothing to save".into()),
    };
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let app_menu = SubmenuBuilder::new(app, "Reqnest")
        .about(Some(AboutMetadata {
            name: Some("Reqnest".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            comments: Some("Local-first API client".into()),
            ..Default::default()
        }))
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-request", "New Request", Some("CmdOrCtrl+T"))?)
        .item(&item("new-collection", "New Collection…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item("open-collection", "Open Collection…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item("import", "Import…", Some("CmdOrCtrl+Shift+I"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let request = SubmenuBuilder::new(app, "Request")
        .item(&item("send", "Send", Some("CmdOrCtrl+Return"))?)
        .item(&item("focus-url", "Focus URL Bar", Some("CmdOrCtrl+L"))?)
        .separator()
        .item(&item("duplicate-tab", "Duplicate Tab", Some("CmdOrCtrl+D"))?)
        .item(&item("next-tab", "Next Tab", Some("Ctrl+Tab"))?)
        .item(&item("prev-tab", "Previous Tab", Some("Ctrl+Shift+Tab"))?)
        .separator()
        .item(&item("run-collection", "Run Collection…", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?)
        .separator()
        .item(&item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?)
        .separator()
        .item(&item("help-docs", "Documentation", None)?)
        .item(&item("help-github", "Reqnest on GitHub", None)?)
        .item(&item("help-issue", "Report an Issue…", None)?)
        .build()?;

    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &request, &view, &window, &help]).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(streams::Streams::default())
        .manage(grpc::Pools::default())
        .manage(mock::MockState::default())
        .manage(mcp::Mcps::default())
        .setup(|app| {
            {
                use tauri::Manager;
                if let Ok(dir) = app.path().app_data_dir() {
                    cookies::init(dir.join("cookies.json"));
                }
            }
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            send_request,
            streams::sse_connect,
            streams::ws_connect,
            streams::ws_send,
            streams::ws_close,
            streams::stream_stop,
            grpc::grpc_describe,
            grpc::grpc_call,
            grpc::grpc_send,
            grpc::grpc_end,
            oauth_listen,
            list_tree,
            list_files,
            list_files_recursive,
            read_text,
            write_text,
            make_dir,
            remove_path,
            rename_path,
            path_exists,
            save_bytes,
            cookies::cookies_list,
            cookies::cookies_delete,
            cookies::cookies_clear,
            cookies::cookies_add,
            mock::mock_start,
            mock::mock_stop,
            mcp::mcp_connect,
            mcp::mcp_request,
            mcp::mcp_close
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

#[cfg(test)]
mod network_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn spec(url: &str, network: NetworkSettings) -> RequestSpec {
        RequestSpec {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body: None, multipart: None, body_file: None,
            timeout_ms: Some(5000),
            insecure: false,
            follow_redirects: true,
            network,
        }
    }

    /// A one-shot fake proxy: records the request head and answers 200 "via-proxy".
    async fn fake_proxy() -> (u16, tokio::task::JoinHandle<String>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let body = "via-proxy";
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            s.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (port, h)
    }

    #[tokio::test]
    async fn custom_proxy_is_used_and_custom_user_agent_sent() {
        let (port, seen) = fake_proxy().await;
        let net = NetworkSettings {
            proxy_mode: "custom".into(),
            proxy_url: format!("http://127.0.0.1:{port}"),
            user_agent: "ReqnestTest/9".into(),
            ..Default::default()
        };
        let res = send_request(spec("http://api.invalid/path?q=1", net)).await.unwrap();
        assert_eq!(res.body, "via-proxy");
        let head = seen.await.unwrap();
        assert!(head.starts_with("GET http://api.invalid/path?q=1 HTTP/1.1"), "got: {head}");
        assert!(head.to_lowercase().contains("user-agent: reqnesttest/9"));
    }

    async fn serve_once(content_type: &str, body: Vec<u8>) -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let ct = content_type.to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = s.read(&mut buf).await.unwrap();
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).await.unwrap();
            s.write_all(&body).await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn binary_bodies_come_back_as_base64_and_text_stays_text() {
        let png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        let port = serve_once("image/png", png.clone()).await;
        let res = send_request(spec(&format!("http://127.0.0.1:{port}/a.png"), Default::default())).await.unwrap();
        assert!(res.body.is_empty());
        use base64::Engine;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(res.body_base64.unwrap()).unwrap(), png);
        assert_eq!(res.content_type, "image/png");
        assert_eq!(res.size_bytes, 10);
        assert!(res.ttfb_ms <= res.time_ms);

        let port = serve_once("application/json", "{\"é\":1}".as_bytes().to_vec()).await;
        let res = send_request(spec(&format!("http://127.0.0.1:{port}/"), Default::default())).await.unwrap();
        assert_eq!(res.body, "{\"é\":1}");
        assert!(res.body_base64.is_none());

        // unknown type + invalid UTF-8 is treated as binary too
        let port = serve_once("application/x-whatever", vec![0xff, 0xfe, 0x00]).await;
        let res = send_request(spec(&format!("http://127.0.0.1:{port}/"), Default::default())).await.unwrap();
        assert!(res.body_base64.is_some());
    }

    #[test]
    fn save_bytes_writes_text_and_binary() {
        let dir = std::env::temp_dir().join(format!("reqnest-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = dir.join("a.txt").to_string_lossy().to_string();
        save_bytes(t.clone(), None, Some("hi".into())).unwrap();
        assert_eq!(std::fs::read(&t).unwrap(), b"hi");
        let b = dir.join("b.bin").to_string_lossy().to_string();
        save_bytes(b.clone(), Some("AQID".into()), None).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), vec![1, 2, 3]);
        assert!(save_bytes(b, None, None).is_err());
    }

    #[tokio::test]
    async fn bad_ca_path_and_bad_proxy_give_clear_errors() {
        let e = send_request(spec("http://x.invalid", NetworkSettings { ca_cert: "/nope/ca.pem".into(), ..Default::default() }))
            .await
            .err()
            .unwrap();
        assert!(e.contains("CA certificate /nope/ca.pem"), "{e}");
        let e = send_request(spec("http://x.invalid", NetworkSettings { proxy_mode: "custom".into(), proxy_url: "::not a url".into(), ..Default::default() }))
            .await
            .err()
            .unwrap();
        assert!(e.contains("Invalid proxy URL"), "{e}");
    }
}

#[cfg(test)]
mod multipart_tests {
    use super::*;

    #[test]
    fn multipart_encodes_text_and_file_parts() {
        let dir = std::env::temp_dir().join(format!("reqnest-mp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("report.txt");
        std::fs::write(&file, b"FILEDATA").unwrap();
        let parts = vec![
            MultipartPart { name: "title".into(), value: "Hello".into(), file: false, content_type: None },
            MultipartPart { name: "doc".into(), value: file.to_string_lossy().into(), file: true, content_type: Some("text/plain".into()) },
        ];
        let (body, ct) = build_multipart(&parts).unwrap();
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with(&format!("--{boundary}\r\n")));
        assert!(text.contains("name=\"title\"\r\n\r\nHello\r\n"));
        assert!(text.contains("name=\"doc\"; filename=\"report.txt\"\r\nContent-Type: text/plain\r\n\r\nFILEDATA\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_file_gives_a_clear_error() {
        let parts = vec![MultipartPart { name: "doc".into(), value: "/nope/missing.bin".into(), file: true, content_type: None }];
        let err = build_multipart(&parts).unwrap_err();
        assert!(err.contains("doc") && err.contains("/nope/missing.bin"));
    }
}
