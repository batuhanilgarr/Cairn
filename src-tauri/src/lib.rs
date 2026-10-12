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
            list_tree,
            list_files,
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
