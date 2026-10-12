use serde::{Deserialize, Serialize};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![send_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
