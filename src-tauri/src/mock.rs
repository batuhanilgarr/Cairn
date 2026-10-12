//! A small local mock server: routes come from the collection's saved example responses.
//! Path templates `{id}`, `:id` and `{{id}}` match one segment; the most specific route wins.
//! Bodies can use {{params.x}}, {{query.x}}, {{$uuid}}, {{$timestamp}}, {{$randomInt}}.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::task::AbortHandle;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub method: String,
    /// e.g. "/users/{id}"
    pub path: String,
    /// Which request this came from, for the log.
    pub name: String,
    pub examples: Vec<Example>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub name: String,
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub delay_ms: u64,
}

fn segments(p: &str) -> Vec<&str> {
    p.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect()
}

fn param_name(seg: &str) -> Option<&str> {
    if let Some(n) = seg.strip_prefix("{{").and_then(|s| s.strip_suffix("}}")) {
        return Some(n.trim());
    }
    if let Some(n) = seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        return Some(n.trim());
    }
    seg.strip_prefix(':')
}

/// Returns the captured path parameters and how many wildcards were needed (fewer = more specific).
fn matches(route: &Route, method: &Method, path: &str) -> Option<(HashMap<String, String>, usize)> {
    if !route.method.eq_ignore_ascii_case(method.as_str()) {
        return None;
    }
    let (want, got) = (segments(&route.path), segments(path));
    if want.len() != got.len() {
        return None;
    }
    let mut params = HashMap::new();
    for (w, g) in want.iter().zip(&got) {
        match param_name(w) {
            Some(n) => {
                params.insert(n.to_string(), urldecode(g));
            }
            None if w == g => {}
            None => return None,
        }
    }
    let wild = params.len();
    Some((params, wild))
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_map(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (urldecode(k), urldecode(v))
        })
        .collect()
}

pub fn render(body: &str, params: &HashMap<String, String>, query: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let key = after[..end].trim();
        let value = match key {
            "$uuid" => Some(uuid::Uuid::new_v4().to_string()),
            "$timestamp" => Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default()),
            "$isoTimestamp" => Some(chrono_like_iso()),
            "$randomInt" => Some((uuid::Uuid::new_v4().as_u128() % 1000).to_string()),
            k if k.starts_with("params.") => params.get(&k[7..]).cloned(),
            k if k.starts_with("query.") => query.get(&k[6..]).cloned(),
            _ => None,
        };
        match value {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[start..start + 2 + end + 2]), // unknown: leave as written
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn chrono_like_iso() -> String {
    let t = time::OffsetDateTime::now_utc();
    t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

pub type Log = Arc<dyn Fn(Value) + Send + Sync>;

async fn handle(req: Request<Incoming>, routes: Arc<Vec<Route>>, log: Log) -> Result<Response<Full<Bytes>>, Infallible> {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = query_map(req.uri().query().unwrap_or(""));
    let want_example = req.headers().get("x-mock-example").and_then(|v| v.to_str().ok()).map(String::from).or_else(|| query.get("__example").cloned());
    let want_status = req.headers().get("x-mock-status").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u16>().ok());
    let _ = req.into_body().collect().await; // drain

    let cors = |b: hyper::http::response::Builder| {
        b.header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD")
            .header("access-control-allow-headers", "*")
            .header("access-control-expose-headers", "*")
    };

    if method == Method::OPTIONS {
        log(json!({"method": "OPTIONS", "path": path, "status": 204, "route": "(CORS preflight)", "ms": 0}));
        return Ok(cors(Response::builder().status(204)).body(Full::new(Bytes::new())).unwrap());
    }

    let mut best: Option<(&Route, HashMap<String, String>, usize)> = None;
    for r in routes.iter() {
        if let Some((p, wild)) = matches(r, &method, &path) {
            if best.as_ref().map_or(true, |(_, _, w)| wild < *w) {
                best = Some((r, p, wild));
            }
        }
    }

    let Some((route, params, _)) = best else {
        let listing: Vec<String> = routes.iter().map(|r| format!("{} {}", r.method.to_uppercase(), r.path)).collect();
        log(json!({"method": method.as_str(), "path": path, "status": 404, "route": null, "ms": started.elapsed().as_millis() as u64}));
        let body = json!({"error": format!("No mock route for {} {}", method, path), "routes": listing}).to_string();
        return Ok(cors(Response::builder().status(404).header("content-type", "application/json")).body(Full::new(Bytes::from(body))).unwrap());
    };

    let ex = want_example
        .as_deref()
        .and_then(|n| route.examples.iter().find(|e| e.name.eq_ignore_ascii_case(n)))
        .or_else(|| want_status.and_then(|s| route.examples.iter().find(|e| e.status == s)))
        .or_else(|| route.examples.first());
    let (status, headers, body, delay) = match ex {
        Some(e) => (e.status, e.headers.clone(), render(&e.body, &params, &query), e.delay_ms),
        None => (200, vec![("Content-Type".into(), "application/json".into())], "{}".to_string(), 0),
    };
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let mut b = cors(Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK)));
    let mut has_ct = false;
    for (k, v) in &headers {
        has_ct |= k.eq_ignore_ascii_case("content-type");
        b = b.header(k.as_str(), v.as_str());
    }
    if !has_ct && !body.is_empty() {
        b = b.header("content-type", if body.trim_start().starts_with(['{', '[']) { "application/json" } else { "text/plain" });
    }
    log(json!({"method": method.as_str(), "path": path, "status": status, "route": format!("{} {}", route.method.to_uppercase(), route.path), "example": ex.map(|e| e.name.clone()), "ms": started.elapsed().as_millis() as u64}));
    let body = if method == Method::HEAD { Bytes::new() } else { Bytes::from(body) };
    Ok(b.body(Full::new(body)).unwrap())
}

pub struct Running {
    pub port: u16,
    abort: AbortHandle,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

/// Start serving on 127.0.0.1. `port` 0 picks a free one; if the chosen port is busy, the next few are tried.
pub async fn start(port: u16, routes: Vec<Route>, log: Log) -> Result<Running, String> {
    let mut listener = None;
    let mut last = String::new();
    for p in (0..8u16).map(|i| if port == 0 { 0 } else { port.wrapping_add(i) }) {
        match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], p))).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => last = e.to_string(),
        }
    }
    let listener = listener.ok_or_else(|| format!("Couldn't start the mock server: {last}"))?;
    let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
    let routes = Arc::new(routes);
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let (routes, log) = (routes.clone(), log.clone());
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| handle(req, routes.clone(), log.clone()));
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });
    Ok(Running { port: actual, abort: task.abort_handle() })
}

/* --------------------------- Tauri commands --------------------------- */

use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct MockState(Mutex<Option<Running>>);

#[tauri::command]
pub async fn mock_start(app: AppHandle, state: State<'_, MockState>, port: u16, routes: Vec<Route>) -> Result<u16, String> {
    state.0.lock().unwrap().take(); // stop a previous one first
    let log: Log = Arc::new(move |v| {
        let _ = app.emit("mock", v);
    });
    let running = start(port, routes, log).await?;
    let p = running.port;
    *state.0.lock().unwrap() = Some(running);
    Ok(p)
}

#[tauri::command]
pub fn mock_stop(state: State<'_, MockState>) {
    state.0.lock().unwrap().take();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(name: &str, status: u16, body: &str) -> Example {
        Example { name: name.into(), status, headers: vec![], body: body.into(), delay_ms: 0 }
    }
    fn route(method: &str, path: &str, examples: Vec<Example>) -> Route {
        Route { method: method.into(), path: path.into(), name: path.into(), examples }
    }

    #[test]
    fn template_rendering() {
        let mut p = HashMap::new();
        p.insert("id".into(), "42".into());
        let mut q = HashMap::new();
        q.insert("page".into(), "2".into());
        let out = render(r#"{"id":"{{params.id}}","page":{{query.page}},"unknown":"{{nope}}","u":"{{$uuid}}","half":"{{oops"}"#, &p, &q);
        assert!(out.contains(r#""id":"42""#) && out.contains(r#""page":2"#) && out.contains("{{nope}}") && out.contains("{{oops"), "{out}");
        assert_eq!(out.matches('-').count(), 4, "uuid inserted: {out}");
        assert_eq!(render("no vars", &p, &q), "no vars");
    }

    #[test]
    fn route_matching_and_specificity() {
        let r = route("GET", "/users/{id}/posts/:post", vec![]);
        let (params, wild) = matches(&r, &Method::GET, "/users/7/posts/hello%20world?x=1").unwrap();
        assert_eq!((params["id"].as_str(), params["post"].as_str(), wild), ("7", "hello world", 2));
        assert!(matches(&r, &Method::POST, "/users/7/posts/a").is_none());
        assert!(matches(&r, &Method::GET, "/users/7/posts").is_none());
        assert!(matches(&route("GET", "/a/{{x}}", vec![]), &Method::GET, "/a/b").is_some());
    }

    #[tokio::test]
    async fn serves_examples_with_params_cors_delay_selection_and_404() {
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let ev = events.clone();
        let routes = vec![
            route("GET", "/users/{id}", vec![ex("ok", 200, r#"{"id":"{{params.id}}","q":"{{query.q}}"}"#), Example { name: "gone".into(), status: 410, headers: vec![("X-Reason".into(), "deleted".into())], body: r#"{"error":"gone"}"#.into(), delay_ms: 0 }]),
            route("GET", "/users/me", vec![ex("me", 200, r#"{"me":true}"#)]),
            route("POST", "/slow", vec![Example { name: "slow".into(), status: 201, headers: vec![], body: "created".into(), delay_ms: 150 }]),
            route("GET", "/empty", vec![]),
        ];
        let run = start(0, routes, Arc::new(move |v| ev.lock().unwrap().push(v))).await.unwrap();
        let base = format!("http://127.0.0.1:{}", run.port);
        let c = reqwest::Client::new();

        let r = c.get(format!("{base}/users/9?q=hi")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
        assert_eq!(r.headers()["content-type"], "application/json");
        assert_eq!(r.text().await.unwrap(), r#"{"id":"9","q":"hi"}"#);

        // the literal route is more specific than the wildcard one
        assert_eq!(c.get(format!("{base}/users/me")).send().await.unwrap().text().await.unwrap(), r#"{"me":true}"#);

        // pick another example by name or by status
        let r = c.get(format!("{base}/users/9")).header("X-Mock-Example", "gone").send().await.unwrap();
        assert_eq!((r.status().as_u16(), r.headers()["x-reason"].to_str().unwrap().to_string()), (410, "deleted".to_string()));
        assert_eq!(c.get(format!("{base}/users/9")).header("X-Mock-Status", "410").send().await.unwrap().status(), 410);
        assert_eq!(c.get(format!("{base}/users/9?__example=gone")).send().await.unwrap().status(), 410);

        // delay is honoured
        let t = Instant::now();
        let r = c.post(format!("{base}/slow")).body("x").send().await.unwrap();
        assert_eq!(r.status(), 201);
        assert!(t.elapsed() >= Duration::from_millis(140));

        // a route with no examples answers 200 {}
        assert_eq!(c.get(format!("{base}/empty")).send().await.unwrap().text().await.unwrap(), "{}");

        // preflight
        let r = c.request(Method::OPTIONS, format!("{base}/users/1")).send().await.unwrap();
        assert_eq!(r.status(), 204);
        assert!(r.headers().contains_key("access-control-allow-methods"));

        // unknown route lists what exists
        let r = c.get(format!("{base}/nope")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let j: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
        assert!(j["routes"].as_array().unwrap().iter().any(|x| x == "GET /users/{id}"));

        // everything was logged, including which route and example answered
        let log = events.lock().unwrap().clone();
        assert!(log.iter().any(|e| e["path"] == "/users/9" && e["route"] == "GET /users/{id}" && e["example"] == "gone"));
        assert!(log.iter().any(|e| e["status"] == 404 && e["route"].is_null()));
        drop(run);
    }

    #[tokio::test]
    async fn busy_port_falls_through_to_the_next_one_and_drop_stops_the_server() {
        let first = start(0, vec![], Arc::new(|_| {})).await.unwrap();
        let second = start(first.port, vec![], Arc::new(|_| {})).await.unwrap();
        assert_ne!(first.port, second.port);
        let port = first.port;
        drop(first);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(reqwest::Client::new().get(format!("http://127.0.0.1:{port}/")).send().await.is_err());
    }
}
