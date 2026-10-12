//! MCP (Model Context Protocol) client: Streamable HTTP and stdio transports.
//! Messages are JSON-RPC 2.0; every message in either direction is reported through `emit` for the wire log.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use crate::streams::{Emit, SseParser, Utf8Chunks};
use crate::{NetworkSettings, RequestSpec};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "transport")]
pub enum McpConfig {
    #[serde(rename = "http")]
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<(String, String)>,
        #[serde(default)]
        insecure: bool,
        #[serde(default)]
        timeout_ms: u64,
        #[serde(default)]
        network: NetworkSettings,
    },
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        /// Resolve the user's login-shell PATH first (a Finder-launched app doesn't inherit it). Off in tests.
        #[serde(default = "yes", rename = "resolvePath")]
        resolve_path: bool,
    },
}
fn yes() -> bool {
    true
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;
type Stdin = Arc<tokio::sync::Mutex<ChildStdin>>;

enum Transport {
    Http { client: reqwest::Client, url: String, headers: Vec<(String, String)>, session: Mutex<Option<String>>, timeout: Duration },
    Stdio { stdin: Stdin, pending: Pending, closed: Arc<AtomicBool>, child: Mutex<Option<Child>> },
}

pub struct Session {
    t: Transport,
    next: AtomicU64,
    emit: Emit,
    id: String,
}

fn idkey(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn rpc_error(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(format!("{} (code {})", e.get("message").and_then(|m| m.as_str()).unwrap_or("error"), e.get("code").map(|c| c.to_string()).unwrap_or_default()))
}

/// What to answer when the server sends us a request. We declare no client capabilities, so only `ping` is expected.
fn reply_to_server_request(v: &Value) -> Value {
    let id = v["id"].clone();
    if v["method"] == "ping" {
        json!({"jsonrpc": "2.0", "id": id, "result": {}})
    } else {
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Method not found: {}", v["method"].as_str().unwrap_or(""))}})
    }
}

/// The login shell knows the user's real PATH (Homebrew, nvm, uv ...); a Finder-launched app does not.
async fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = tokio::time::timeout(
        Duration::from_secs(4),
        tokio::process::Command::new(shell).args(["-ilc", "printf '__RQ__%s__RQ__' \"$PATH\""]).stdin(std::process::Stdio::null()).output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let a = s.find("__RQ__")? + 6;
    let b = s[a..].find("__RQ__")? + a;
    Some(s[a..b].to_string())
}

async fn write_line(stdin: &Stdin, v: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(v).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut g = stdin.lock().await;
    g.write_all(line.as_bytes()).await.map_err(|e| format!("The server's input is closed: {e}"))?;
    g.flush().await.map_err(|e| e.to_string())
}

impl Session {
    pub async fn connect(id: String, cfg: McpConfig, emit: Emit) -> Result<(Arc<Session>, Value), String> {
        let t = match cfg {
            McpConfig::Http { url, headers, insecure, timeout_ms, network } => {
                if url.trim().is_empty() {
                    return Err("Enter the MCP server URL".into());
                }
                let spec = RequestSpec { method: "POST".into(), url: url.clone(), headers: vec![], body: None, timeout_ms: Some(30_000), insecure, follow_redirects: true, network };
                let client = crate::build_client(&spec, reqwest::redirect::Policy::limited(5), true)?;
                let timeout = Duration::from_millis(if timeout_ms == 0 { 60_000 } else { timeout_ms });
                Transport::Http { client, url, headers, session: Mutex::new(None), timeout }
            }
            McpConfig::Stdio { command, args, env, resolve_path } => {
                if command.trim().is_empty() {
                    return Err("Enter the command that starts the MCP server".into());
                }
                let mut cmd = tokio::process::Command::new(command.trim());
                cmd.args(&args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
                if resolve_path {
                    if let Some(p) = login_path().await {
                        cmd.env("PATH", p);
                    }
                }
                for (k, v) in env.iter().filter(|(k, _)| !k.trim().is_empty()) {
                    cmd.env(k, v);
                }
                let mut child = cmd.spawn().map_err(|e| format!("Couldn't start \"{}\": {e}. Is it installed and on your PATH?", command.trim()))?;
                let stdin: Stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or("no stdin")?));
                let stdout = child.stdout.take().ok_or("no stdout")?;
                let stderr = child.stderr.take().ok_or("no stderr")?;
                let pending: Pending = Arc::default();
                let closed = Arc::new(AtomicBool::new(false));

                // stdout: one JSON-RPC message per line
                {
                    let (pending, stdin, emit, id, closed) = (pending.clone(), stdin.clone(), emit.clone(), id.clone(), closed.clone());
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(stdout).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let line = line.trim();
                            if line.is_empty() {
                                continue;
                            }
                            let Ok(v) = serde_json::from_str::<Value>(line) else {
                                emit(json!({"id": id, "type": "stderr", "text": format!("(not JSON on stdout) {line}")}));
                                continue;
                            };
                            emit(json!({"id": id, "type": "message", "text": pretty(&v)}));
                            if v.get("method").is_some() {
                                if v.get("id").is_some() {
                                    let reply = reply_to_server_request(&v);
                                    emit(json!({"id": id, "type": "sent", "text": pretty(&reply)}));
                                    let _ = write_line(&stdin, &reply).await;
                                }
                            } else if let Some(i) = v.get("id") {
                                if let Some(tx) = pending.lock().unwrap().remove(&idkey(i)) {
                                    let _ = tx.send(v);
                                }
                            }
                        }
                        // The process is gone: fail everything still waiting instead of letting it time out.
                        closed.store(true, Ordering::SeqCst);
                        pending.lock().unwrap().clear();
                        emit(json!({"id": id, "type": "end"}));
                    });
                }
                // stderr is where servers log; show it
                {
                    let (emit, id) = (emit.clone(), id.clone());
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            emit(json!({"id": id, "type": "stderr", "text": line}));
                        }
                    });
                }
                Transport::Stdio { stdin, pending, closed, child: Mutex::new(Some(child)) }
            }
        };

        let session = Arc::new(Session { t, next: AtomicU64::new(1), emit, id });
        let init = session
            .request("initialize", json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "Reqnest", "version": env!("CARGO_PKG_VERSION")}}))
            .await?;
        session.notify("notifications/initialized", json!({})).await?;
        Ok((session, init))
    }

    fn sent(&self, v: &Value) {
        (self.emit)(json!({"id": self.id, "type": "sent", "text": pretty(v)}));
    }
    fn incoming(&self, v: &Value) {
        (self.emit)(json!({"id": self.id, "type": "message", "text": pretty(v)}));
    }

    async fn http_post(&self, body: &Value, initialize: bool) -> Result<reqwest::Response, String> {
        let Transport::Http { client, url, headers, session, .. } = &self.t else { unreachable!() };
        let mut req = client.post(url).header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream");
        for (k, v) in headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
            req = req.header(k.as_str(), v.as_str());
        }
        if !initialize {
            req = req.header("MCP-Protocol-Version", PROTOCOL_VERSION);
            if let Some(s) = session.lock().unwrap().clone() {
                req = req.header("Mcp-Session-Id", s);
            }
        }
        req.body(body.to_string()).send().await.map_err(crate::describe_error)
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        self.sent(&msg);
        match &self.t {
            Transport::Stdio { stdin, .. } => write_line(stdin, &msg).await,
            Transport::Http { .. } => {
                let r = self.http_post(&msg, false).await?;
                if !r.status().is_success() {
                    return Err(format!("The server rejected the notification: HTTP {}", r.status()));
                }
                Ok(())
            }
        }
    }

    /// Send a request and wait for its response. Returns the `result`, or an error describing the JSON-RPC error.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        let msg = json!({"jsonrpc": "2.0", "id": n, "method": method, "params": params});
        self.sent(&msg);
        let resp = match &self.t {
            Transport::Stdio { stdin, pending, closed, .. } => {
                if closed.load(Ordering::SeqCst) {
                    return Err("The server has exited".into());
                }
                let (tx, rx) = oneshot::channel();
                pending.lock().unwrap().insert(n.to_string(), tx);
                if closed.load(Ordering::SeqCst) {
                    pending.lock().unwrap().remove(&n.to_string()); // lost a race with the exit
                    return Err("The server has exited".into());
                }
                write_line(stdin, &msg).await?;
                match tokio::time::timeout(Duration::from_secs(60), rx).await {
                    Ok(Ok(v)) => v,
                    Ok(Err(_)) => return Err("The server exited before answering".into()),
                    Err(_) => {
                        pending.lock().unwrap().remove(&n.to_string());
                        return Err(format!("No response to {method} after 60 s"));
                    }
                }
            }
            Transport::Http { timeout, session, .. } => {
                let fut = async {
                    let r = self.http_post(&msg, method == "initialize").await?;
                    let status = r.status();
                    if method == "initialize" {
                        if let Some(s) = r.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
                            *session.lock().unwrap() = Some(s.to_string());
                        }
                    }
                    if !status.is_success() {
                        let body = r.text().await.unwrap_or_default();
                        let hint = if status.as_u16() == 401 || status.as_u16() == 403 { " Check the Auth tab: this server needs credentials." } else if status.as_u16() == 404 { " The session may have expired: disconnect and connect again." } else { "" };
                        return Err(format!("HTTP {status}.{hint}{}", if body.is_empty() { String::new() } else { format!(" {}", body.chars().take(300).collect::<String>()) }));
                    }
                    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
                    if ct.contains("text/event-stream") {
                        let mut parser = SseParser::default();
                        let mut utf8 = Utf8Chunks::default();
                        let mut stream = r.bytes_stream();
                        while let Some(chunk) = stream.next().await {
                            let chunk = chunk.map_err(crate::describe_error)?;
                            for ev in parser.feed(&utf8.push(&chunk)) {
                                let Ok(v) = serde_json::from_str::<Value>(&ev.data) else { continue };
                                for m in if v.is_array() { v.as_array().cloned().unwrap_or_default() } else { vec![v] } {
                                    self.incoming(&m);
                                    if m.get("method").is_some() {
                                        if m.get("id").is_some() {
                                            let reply = reply_to_server_request(&m);
                                            self.sent(&reply);
                                            let _ = self.http_post(&reply, false).await;
                                        }
                                    } else if m.get("id").map(idkey) == Some(n.to_string()) {
                                        return Ok(m);
                                    }
                                }
                            }
                        }
                        Err("The stream ended without a response".to_string())
                    } else {
                        let v: Value = serde_json::from_str(&r.text().await.map_err(crate::describe_error)?).map_err(|e| format!("The server didn't return JSON: {e}"))?;
                        let found = if v.is_array() { v.as_array().and_then(|a| a.iter().find(|m| m.get("id").map(idkey) == Some(n.to_string())).cloned()) } else { Some(v) };
                        let m = found.ok_or("No matching response in the reply")?;
                        self.incoming(&m);
                        Ok(m)
                    }
                };
                tokio::time::timeout(*timeout, fut).await.map_err(|_| format!("No response to {method} within {} s", timeout.as_secs()))??
            }
        };
        if let Some(e) = rpc_error(&resp) {
            return Err(e);
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn close(&self) {
        match &self.t {
            Transport::Http { client, url, session, headers, .. } => {
                let sid = session.lock().unwrap().clone();
                if let Some(s) = sid {
                    let mut r = client.delete(url).header("Mcp-Session-Id", s);
                    for (k, v) in headers {
                        r = r.header(k.as_str(), v.as_str());
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(2), r.send()).await;
                }
            }
            Transport::Stdio { child, closed, pending, .. } => {
                closed.store(true, Ordering::SeqCst);
                pending.lock().unwrap().clear();
                if let Some(mut c) = child.lock().unwrap().take() {
                    let _ = c.start_kill();
                }
            }
        }
    }
}

/* --------------------------- Tauri commands --------------------------- */

use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Mcps(Mutex<HashMap<String, Arc<Session>>>);

#[tauri::command]
pub async fn mcp_connect(app: AppHandle, state: State<'_, Mcps>, id: String, config: McpConfig) -> Result<Value, String> {
    let old = state.0.lock().unwrap().remove(&id);
    if let Some(old) = old {
        old.close().await;
    }
    let emit: Emit = Arc::new(move |v| {
        let _ = app.emit("stream", v);
    });
    let (session, init) = Session::connect(id.clone(), config, emit).await?;
    state.0.lock().unwrap().insert(id, session);
    Ok(init)
}

#[tauri::command]
pub async fn mcp_request(state: State<'_, Mcps>, id: String, method: String, params: Value) -> Result<Value, String> {
    let s = state.0.lock().unwrap().get(&id).cloned().ok_or("Not connected")?;
    s.request(&method, params).await
}

#[tauri::command]
pub async fn mcp_close(state: State<'_, Mcps>, id: String) -> Result<(), String> {
    let s = state.0.lock().unwrap().remove(&id);
    if let Some(s) = s {
        s.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn collector() -> (Emit, Arc<Mutex<Vec<Value>>>) {
        let log: Arc<Mutex<Vec<Value>>> = Arc::default();
        let l = log.clone();
        (Arc::new(move |v| l.lock().unwrap().push(v)), log)
    }

    const PY_SERVER: &str = r#"
import sys, json
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    m = json.loads(line)
    if "method" not in m:
        continue
    meth, mid = m["method"], m.get("id")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "py-test", "version": "1"}}})
    elif meth == "notifications/initialized":
        sys.stderr.write("client initialized\n"); sys.stderr.flush()
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": "srv-ping", "method": "ping"})
        reply = json.loads(sys.stdin.readline())
        assert reply.get("id") == "srv-ping" and reply.get("result") == {}, reply
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}})
    elif meth == "tools/call":
        p = m["params"]
        if p["name"] == "boom":
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "bad args"}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": p["arguments"].get("text", "")}], "isError": False}})
"#;

    #[tokio::test]
    async fn stdio_session_answers_server_pings_and_reports_errors() {
        let (emit, log) = collector();
        let cfg = McpConfig::Stdio { command: "python3".into(), args: vec!["-u".into(), "-c".into(), PY_SERVER.into()], env: vec![], resolve_path: false };
        let (s, init) = Session::connect("t".into(), cfg, emit).await.expect("connect");
        assert_eq!(init["serverInfo"]["name"], "py-test");

        // the server sends us a `ping` request mid-way and won't answer until we reply
        let tools = tokio::time::timeout(Duration::from_secs(10), s.request("tools/list", json!({}))).await.expect("hung: ping not answered").unwrap();
        assert_eq!(tools["tools"][0]["name"], "echo");

        let r = s.request("tools/call", json!({"name": "echo", "arguments": {"text": "héllo"}})).await.unwrap();
        assert_eq!(r["content"][0]["text"], "héllo");
        let e = s.request("tools/call", json!({"name": "boom", "arguments": {}})).await.unwrap_err();
        assert!(e.contains("bad args") && e.contains("-32602"), "{e}");

        tokio::time::sleep(Duration::from_millis(150)).await;
        let log = log.lock().unwrap().clone();
        assert!(log.iter().any(|e| e["type"] == "stderr" && e["text"] == "client initialized"));
        assert!(log.iter().any(|e| e["type"] == "sent" && e["text"].as_str().unwrap().contains("srv-ping")), "reply to ping was logged");
        assert!(log.iter().any(|e| e["type"] == "sent" && e["text"].as_str().unwrap().contains("\"initialize\"")));
        s.close().await;
        assert!(s.request("tools/list", json!({})).await.is_err(), "closed session must fail, not hang");
    }

    #[tokio::test]
    async fn stdio_start_failure_is_readable() {
        let (emit, _) = collector();
        let cfg = McpConfig::Stdio { command: "definitely-not-a-real-command-xyz".into(), args: vec![], env: vec![], resolve_path: false };
        let e = Session::connect("t".into(), cfg, emit).await.err().unwrap();
        assert!(e.contains("Couldn't start") && e.contains("PATH"), "{e}");
    }

    /// Reads one HTTP request: (lower-cased head, body)
    async fn read_request(s: &mut tokio::net::TcpStream) -> (String, String) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        loop {
            let n = s.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
                while buf.len() < i + 4 + len {
                    let n = s.read(&mut tmp).await.unwrap();
                    buf.extend_from_slice(&tmp[..n]);
                }
                return (head, String::from_utf8_lossy(&buf[i + 4..i + 4 + len]).to_string());
            }
        }
        (String::new(), String::new())
    }

    #[tokio::test]
    async fn http_session_handles_json_sse_session_ids_and_errors() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let seen2 = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let (head, body) = read_request(&mut s).await;
                let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                seen2.lock().unwrap().push((head.clone(), v.clone()));
                let id = v["id"].clone();
                let (status, ctype, extra, out) = match v["method"].as_str().unwrap_or("") {
                    "initialize" => ("200 OK", "application/json", "Mcp-Session-Id: sess-9\r\n", json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"http-test"}}}).to_string()),
                    "notifications/initialized" => ("202 Accepted", "text/plain", "", String::new()),
                    "tools/list" => {
                        // SSE: a notification first, then the response
                        let note = json!({"jsonrpc":"2.0","method":"notifications/message","params":{"data":"hi"}});
                        let res = json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"t1"}]}});
                        ("200 OK", "text/event-stream", "", format!("event: message\ndata: {note}\n\nevent: message\ndata: {res}\n\n"))
                    }
                    "tools/call" if v["params"]["name"] == "boom" => ("200 OK", "application/json", "", json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"kaboom"}}).to_string()),
                    "tools/call" => ("200 OK", "application/json", "", json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"ok"}]}}).to_string()),
                    "locked" => ("401 Unauthorized", "text/plain", "", "no token".into()),
                    _ => ("200 OK", "text/plain", "", String::new()),
                };
                let resp = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
                s.write_all(resp.as_bytes()).await.unwrap();
            }
        });

        let (emit, log) = collector();
        let cfg = McpConfig::Http { url: format!("http://127.0.0.1:{port}/mcp"), headers: vec![("Authorization".into(), "Bearer abc".into())], insecure: false, timeout_ms: 5000, network: Default::default() };
        let (s, init) = Session::connect("h".into(), cfg, emit).await.expect("connect");
        assert_eq!(init["serverInfo"]["name"], "http-test");

        let tools = s.request("tools/list", json!({})).await.unwrap();
        assert_eq!(tools["tools"][0]["name"], "t1");
        assert_eq!(s.request("tools/call", json!({"name": "x"})).await.unwrap()["content"][0]["text"], "ok");
        assert!(s.request("tools/call", json!({"name": "boom"})).await.unwrap_err().contains("kaboom"));
        let e = s.request("locked", json!({})).await.unwrap_err();
        assert!(e.contains("401") && e.contains("Auth"), "{e}");

        let seen = seen.lock().unwrap().clone();
        let init_head = &seen[0].0;
        assert!(init_head.contains("authorization: bearer abc") && !init_head.contains("mcp-session-id"), "{init_head}");
        assert!(init_head.contains("accept: application/json, text/event-stream"));
        // every later request carries the session id and protocol version
        for (head, _) in &seen[1..] {
            assert!(head.contains("mcp-session-id: sess-9") && head.contains("mcp-protocol-version: 2025-06-18") && head.contains("authorization: bearer abc"), "{head}");
        }
        assert_eq!(seen[1].1["method"], "notifications/initialized");
        assert!(seen[1].1.get("id").is_none(), "notifications have no id");

        let log = log.lock().unwrap().clone();
        assert!(log.iter().any(|e| e["type"] == "message" && e["text"].as_str().unwrap().contains("notifications/message")), "interleaved notification is logged");
    }
}

#[cfg(test)]
mod crash_tests {
    use super::*;

    /// A server that answers `initialize`, then dies when asked for tools.
    const DIES: &str = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"serverInfo": {"name": "dies"}}}), flush=True)
    elif m.get("method") == "tools/list":
        sys.exit(3)
"#;

    #[tokio::test]
    async fn a_server_that_dies_fails_requests_immediately() {
        let emit: Emit = Arc::new(|_| {});
        let cfg = McpConfig::Stdio { command: "python3".into(), args: vec!["-u".into(), "-c".into(), DIES.into()], env: vec![], resolve_path: false };
        let (s, _) = Session::connect("d".into(), cfg, emit).await.unwrap();
        let t = std::time::Instant::now();
        let e = s.request("tools/list", json!({})).await.unwrap_err();
        assert!(e.contains("exited"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(5), "took {:?}", t.elapsed());
        assert!(s.request("tools/list", json!({})).await.unwrap_err().contains("exited"));
    }
}
