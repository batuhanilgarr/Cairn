//! Long-lived connections: Server-Sent Events and WebSockets.
//!
//! Every connection is identified by a UI-chosen id. Events flow back to the UI through a single
//! `emit` callback (a Tauri event in the app, a channel in tests):
//!   {id, type: "open" | "event" | "raw" | "message" | "binary" | "close" | "error" | "end", ...}

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::{build_client, NetworkSettings, RequestSpec};

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub enum WsCmd {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

pub(crate) enum Handle {
    Task(AbortHandle),
    Ws { tx: mpsc::UnboundedSender<WsCmd>, abort: AbortHandle },
    Grpc { tx: mpsc::UnboundedSender<crate::grpc::GrpcCmd>, abort: AbortHandle },
}

#[derive(Default, Clone)]
pub struct Streams(Arc<Mutex<HashMap<String, Handle>>>);

impl Streams {
    pub(crate) fn put(&self, id: &str, h: Handle) {
        if let Some(old) = self.0.lock().unwrap().insert(id.to_string(), h) {
            old.abort();
        }
    }
    pub(crate) fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn stop(&self, id: &str) {
        if let Some(h) = self.0.lock().unwrap().remove(id) {
            h.abort();
        }
    }
    pub(crate) fn grpc_cmd(&self, id: &str, cmd: crate::grpc::GrpcCmd) -> Result<(), String> {
        match self.0.lock().unwrap().get(id) {
            Some(Handle::Grpc { tx, .. }) => tx.send(cmd).map_err(|_| "The call has finished".to_string()),
            _ => Err("No active call".to_string()),
        }
    }
    pub fn ws_send(&self, id: &str, cmd: WsCmd) -> Result<(), String> {
        match self.0.lock().unwrap().get(id) {
            Some(Handle::Ws { tx, .. }) => tx.send(cmd).map_err(|_| "The connection is closed".to_string()),
            _ => Err("Not connected".to_string()),
        }
    }
}

impl Handle {
    fn abort(self) {
        match self {
            Handle::Task(a) => a.abort(),
            Handle::Ws { abort, .. } | Handle::Grpc { abort, .. } => abort.abort(),
        }
    }
}

/* ------------------------------ SSE parsing ------------------------------ */

#[derive(Debug, PartialEq, Clone)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<u64>,
}

/// Incremental parser for the text/event-stream format, tolerant of chunk boundaries anywhere
/// (mid-line, between \r and \n) and of \n, \r\n and \r line endings.
#[derive(Default)]
pub struct SseParser {
    buf: String,
    event: String,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
    last_id: Option<String>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            // find the first line terminator; a trailing lone \r might be half of \r\n, so wait for more input
            let bytes = self.buf.as_bytes();
            let Some(pos) = bytes.iter().position(|&b| b == b'\n' || b == b'\r') else { break };
            let (line_end, skip) = if bytes[pos] == b'\r' {
                if pos + 1 >= bytes.len() {
                    break;
                }
                (pos, if bytes[pos + 1] == b'\n' { 2 } else { 1 })
            } else {
                (pos, 1)
            };
            let line = self.buf[..line_end].to_string();
            self.buf.drain(..line_end + skip);
            if let Some(ev) = self.line(&line) {
                out.push(ev);
            }
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let had = !self.data.is_empty();
            let ev = SseEvent {
                event: if self.event.is_empty() { "message".into() } else { std::mem::take(&mut self.event) },
                data: self.data.join("\n"),
                id: self.id.take(),
                retry: self.retry.take(),
            };
            self.event.clear();
            self.data.clear();
            return if had { Some(ev) } else { None };
        }
        if line.starts_with(':') {
            return None; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data.push(value.to_string()),
            "id" if !value.contains('\0') => {
                self.id = Some(value.to_string());
                self.last_id = self.id.clone();
            }
            "retry" => self.retry = value.parse().ok(),
            _ => {}
        }
        None
    }
}

/// Splits a byte stream into valid UTF-8 text, carrying an incomplete trailing character to the next chunk.
#[derive(Default)]
pub struct Utf8Chunks(Vec<u8>);

impl Utf8Chunks {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        match std::str::from_utf8(&self.0) {
            Ok(s) => {
                let s = s.to_string();
                self.0.clear();
                s
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if e.error_len().is_none() {
                    // incomplete character at the end: keep it
                    let s = String::from_utf8_lossy(&self.0[..valid]).to_string();
                    self.0.drain(..valid);
                    s
                } else {
                    let s = String::from_utf8_lossy(&self.0).to_string();
                    self.0.clear();
                    s
                }
            }
        }
    }
}

/* --------------------------------- SSE run -------------------------------- */

pub async fn run_sse(id: String, spec: RequestSpec, emit: Emit) {
    let ev = |v: Value| {
        let mut v = v;
        v["id"] = json!(id);
        emit(v)
    };
    let method = match reqwest::Method::from_bytes(spec.method.to_uppercase().as_bytes()) {
        Ok(m) => m,
        Err(e) => return ev(json!({"type": "error", "message": format!("Invalid method: {e}")})),
    };
    let client = match build_client(&spec, reqwest::redirect::Policy::limited(10), true) {
        Ok(c) => c,
        Err(e) => return ev(json!({"type": "error", "message": e})),
    };
    let mut req = client.request(method, &spec.url);
    let mut has_accept = false;
    for (k, v) in spec.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        has_accept |= k.eq_ignore_ascii_case("accept");
        req = req.header(k.as_str(), v.as_str());
    }
    if !has_accept {
        req = req.header("Accept", "text/event-stream");
    }
    req = req.header("Cache-Control", "no-cache");
    if let Some(body) = spec.body.filter(|b| !b.is_empty()) {
        req = req.body(body);
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return ev(json!({"type": "error", "message": crate::describe_error(e)})),
    };
    let status = res.status();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let is_sse = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v.contains("text/event-stream"));
    ev(json!({"type": "open", "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or(""), "headers": headers, "sse": is_sse}));

    let mut parser = SseParser::default();
    let mut utf8 = Utf8Chunks::default();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = utf8.push(&bytes);
                if text.is_empty() {
                    continue;
                }
                if is_sse {
                    for e in parser.feed(&text) {
                        ev(json!({"type": "event", "event": e.event, "data": e.data, "lastEventId": e.id, "retry": e.retry}));
                    }
                } else {
                    ev(json!({"type": "raw", "text": text}));
                }
            }
            Err(e) => return ev(json!({"type": "error", "message": crate::describe_error(e)})),
        }
    }
    ev(json!({"type": "end"}));
}

/* ------------------------------- WebSocket ------------------------------- */

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS config honouring the app's network settings (extra CA bundle, client certificate) and the per-request insecure flag.
pub fn tls_config(insecure: bool, n: &NetworkSettings) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;

    let builder = if insecure {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
    } else {
        let mut roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if !n.ca_cert.trim().is_empty() {
            let pem = std::fs::read(n.ca_cert.trim()).map_err(|e| format!("CA certificate {}: {e}", n.ca_cert))?;
            for c in rustls_pemfile::certs(&mut pem.as_slice()) {
                roots.add(c.map_err(|e| format!("CA certificate {}: {e}", n.ca_cert))?).map_err(|e| e.to_string())?;
            }
        }
        builder.with_root_certificates(roots)
    };

    if !n.client_cert.trim().is_empty() {
        let cert_pem = std::fs::read(n.client_cert.trim()).map_err(|e| format!("Client certificate {}: {e}", n.client_cert))?;
        let key_path = if n.client_key.trim().is_empty() { n.client_cert.trim() } else { n.client_key.trim() };
        let key_pem = std::fs::read(key_path).map_err(|e| format!("Client key {key_path}: {e}"))?;
        let certs = rustls_pemfile::certs(&mut cert_pem.as_slice()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("Client certificate: {e}"))?;
        let key = rustls_pemfile::private_key(&mut key_pem.as_slice())
            .map_err(|e| format!("Client key: {e}"))?
            .ok_or("No private key found in the client key file")?;
        return builder.with_client_auth_cert(certs, key).map_err(|e| format!("Client certificate/key: {e}"));
    }
    Ok(builder.with_no_client_auth())
}

pub struct WsArgs {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub protocols: Vec<String>,
    pub insecure: bool,
    pub network: NetworkSettings,
}

pub async fn run_ws(id: String, args: WsArgs, mut rx: mpsc::UnboundedReceiver<WsCmd>, emit: Emit) {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
    let ev = |v: Value| {
        let mut v = v;
        v["id"] = json!(id);
        emit(v)
    };

    let mut request = match args.url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return ev(json!({"type": "error", "message": format!("Invalid WebSocket URL: {e}")})),
    };
    for (k, v) in args.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        let (Ok(name), Ok(val)) = (
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) else {
            return ev(json!({"type": "error", "message": format!("Invalid header: {k}")}));
        };
        request.headers_mut().insert(name, val);
    }
    if !args.protocols.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&args.protocols.join(", ")) {
            request.headers_mut().insert("Sec-WebSocket-Protocol", v);
        }
    }

    let connector = if args.url.starts_with("wss") {
        match tls_config(args.insecure, &args.network) {
            Ok(c) => Some(tokio_tungstenite::Connector::Rustls(Arc::new(c))),
            Err(e) => return ev(json!({"type": "error", "message": e})),
        }
    } else {
        None
    };

    let connect = tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector);
    let (ws, resp) = match tokio::time::timeout(Duration::from_secs(30), connect).await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return ev(json!({"type": "error", "message": format!("{e}")})),
        Err(_) => return ev(json!({"type": "error", "message": "Timed out connecting"})),
    };
    let protocol = resp.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    ev(json!({"type": "open", "status": resp.status().as_u16(), "protocol": protocol}));

    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(t))) => ev(json!({"type": "message", "text": t.to_string()})),
                Some(Ok(Message::Binary(b))) => {
                    use base64::Engine;
                    ev(json!({"type": "binary", "size": b.len(), "base64": base64::engine::general_purpose::STANDARD.encode(&b), "preview": String::from_utf8_lossy(&b[..b.len().min(512)]).to_string()}))
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                    return ev(json!({"type": "close", "code": code, "reason": reason}));
                }
                Some(Ok(_)) => {} // ping/pong are answered by the library
                Some(Err(e)) => return ev(json!({"type": "error", "message": format!("{e}")})),
                None => return ev(json!({"type": "close", "code": 1006, "reason": "Connection lost"})),
            },
            cmd = rx.recv() => match cmd {
                Some(WsCmd::Text(t)) => if let Err(e) = sink.send(Message::Text(t.into())).await { return ev(json!({"type": "error", "message": format!("{e}")})); },
                Some(WsCmd::Binary(b)) => if let Err(e) = sink.send(Message::Binary(b.into())).await { return ev(json!({"type": "error", "message": format!("{e}")})); },
                Some(WsCmd::Close) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    // give the server a moment to acknowledge, so the close handshake completes
                    let _ = tokio::time::timeout(Duration::from_millis(800), async { while stream.next().await.is_some() {} }).await;
                    return ev(json!({"type": "close", "code": 1000, "reason": "Closed by you"}));
                }
            },
        }
    }
}

/* --------------------------- Tauri commands --------------------------- */

use tauri::{AppHandle, Emitter, State};

fn emitter(app: AppHandle) -> Emit {
    Arc::new(move |v| {
        let _ = app.emit("stream", v);
    })
}

#[tauri::command]
pub async fn sse_connect(app: AppHandle, streams: State<'_, Streams>, id: String, spec: RequestSpec) -> Result<(), String> {
    let s = streams.inner().clone();
    let emit = emitter(app);
    let sid = id.clone();
    let task = tokio::spawn(async move {
        run_sse(sid.clone(), spec, emit).await;
        s.remove(&sid);
    });
    streams.put(&id, Handle::Task(task.abort_handle()));
    Ok(())
}

#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    streams: State<'_, Streams>,
    id: String,
    url: String,
    headers: Vec<(String, String)>,
    protocols: Vec<String>,
    insecure: bool,
    network: NetworkSettings,
) -> Result<(), String> {
    let s = streams.inner().clone();
    let emit = emitter(app);
    let (tx, rx) = mpsc::unbounded_channel();
    let sid = id.clone();
    let task = tokio::spawn(async move {
        run_ws(sid.clone(), WsArgs { url, headers, protocols, insecure, network }, rx, emit).await;
        s.remove(&sid);
    });
    streams.put(&id, Handle::Ws { tx, abort: task.abort_handle() });
    Ok(())
}

#[tauri::command]
pub fn ws_send(streams: State<'_, Streams>, id: String, text: Option<String>, base64: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let cmd = match (text, base64) {
        (_, Some(b)) => WsCmd::Binary(base64::engine::general_purpose::STANDARD.decode(b.trim()).map_err(|e| format!("Not valid base64: {e}"))?),
        (Some(t), None) => WsCmd::Text(t),
        _ => return Err("Nothing to send".into()),
    };
    streams.ws_send(&id, cmd)
}

#[tauri::command]
pub fn ws_close(streams: State<'_, Streams>, id: String) -> Result<(), String> {
    streams.ws_send(&id, WsCmd::Close)
}

#[tauri::command]
pub fn stream_stop(streams: State<'_, Streams>, id: String) {
    streams.stop(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn collect(emit_log: &Arc<Mutex<Vec<Value>>>) -> Emit {
        let l = emit_log.clone();
        Arc::new(move |v| l.lock().unwrap().push(v))
    }

    #[test]
    fn sse_parser_handles_fields_comments_and_multiline_data() {
        let mut p = SseParser::default();
        let evs = p.feed(": keepalive\nid: 7\nevent: tick\ndata: one\ndata: two\nretry: 3000\n\ndata: plain\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0], SseEvent { event: "tick".into(), data: "one\ntwo".into(), id: Some("7".into()), retry: Some(3000) });
        assert_eq!((evs[1].event.as_str(), evs[1].data.as_str()), ("message", "plain"));
    }

    #[test]
    fn sse_parser_survives_any_chunking_and_line_endings() {
        let raw = "event: a\r\ndata: héllo\r\n\r\ndata: x\r\rdata: y\n\n";
        let whole = SseParser::default().feed(raw);
        assert_eq!(whole.len(), 3);
        // feed one character at a time: must produce the same events
        let mut p = SseParser::default();
        let mut got = Vec::new();
        for ch in raw.chars() {
            got.extend(p.feed(&ch.to_string()));
        }
        assert_eq!(got, whole);
        assert_eq!(whole[0].data, "héllo");
    }

    #[test]
    fn sse_event_without_data_is_not_dispatched() {
        assert!(SseParser::default().feed("event: x\n\n").is_empty());
    }

    #[test]
    fn utf8_chunks_carry_split_characters() {
        let bytes = "a€b".as_bytes(); // € is 3 bytes
        let mut u = Utf8Chunks::default();
        let mut out = String::new();
        for b in bytes {
            out += &u.push(&[*b]);
        }
        assert_eq!(out, "a€b");
    }

    fn spec(url: &str) -> RequestSpec {
        RequestSpec { method: "GET".into(), url: url.into(), headers: vec![], body: None, multipart: None, body_file: None, timeout_ms: Some(5000), insecure: false, follow_redirects: true, network: Default::default() }
    }

    #[tokio::test]
    async fn sse_stream_end_to_end_with_split_chunks_and_open_after_headers() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let head = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            assert!(head.contains("accept: text/event-stream"), "{head}");
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            let chunk = |d: &[u8]| {
                let mut v = format!("{:x}\r\n", d.len()).into_bytes();
                v.extend_from_slice(d);
                v.extend_from_slice(b"\r\n");
                v
            };
            // split an event, and a multi-byte char, across chunks
            let euro = "data: 5€\n\n".as_bytes();
            s.write_all(&chunk(b"event: price\nda")).await.unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
            s.write_all(&chunk(b"ta: 1\n\ndata: 2\n\n")).await.unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
            s.write_all(&chunk(&euro[..8])).await.unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
            s.write_all(&chunk(&euro[8..])).await.unwrap();
            s.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        run_sse("t1".into(), spec(&format!("http://127.0.0.1:{port}/events")), collect(&log)).await;
        let evs = log.lock().unwrap().clone();
        let types: Vec<_> = evs.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types, ["open", "event", "event", "event", "end"], "{evs:?}");
        assert_eq!(evs[0]["status"], 200);
        assert_eq!(evs[0]["sse"], true);
        assert_eq!((evs[1]["event"].as_str(), evs[1]["data"].as_str()), (Some("price"), Some("1")));
        assert_eq!(evs[3]["data"], "5€");
        assert!(evs.iter().all(|e| e["id"] == "t1"));
    }

    #[tokio::test]
    async fn non_sse_responses_stream_as_raw_text_and_errors_are_reported() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = s.read(&mut buf).await.unwrap();
            s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"error\":\"no\"}\n").await.unwrap();
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        run_sse("t2".into(), spec(&format!("http://127.0.0.1:{port}/")), collect(&log)).await;
        let evs = log.lock().unwrap().clone();
        assert_eq!(evs[0]["status"], 401);
        assert_eq!(evs[0]["sse"], false);
        assert_eq!(evs[1]["type"], "raw");
        assert!(evs[1]["text"].as_str().unwrap().contains("\"error\""));

        let log = Arc::new(Mutex::new(Vec::new()));
        run_sse("t3".into(), spec("http://127.0.0.1:1/"), collect(&log)).await; // nothing listens on port 1
        assert_eq!(log.lock().unwrap()[0]["type"], "error");
    }

    #[tokio::test]
    async fn websocket_echo_binary_close_and_protocol() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let cb = |req: &tokio_tungstenite::tungstenite::handshake::server::Request, mut resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                assert_eq!(req.headers().get("x-token").unwrap(), "abc");
                resp.headers_mut().insert("Sec-WebSocket-Protocol", "chat".parse().unwrap());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(s, cb).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                use tokio_tungstenite::tungstenite::Message;
                match m {
                    Message::Text(t) => ws.send(Message::Text(format!("echo:{t}").into())).await.unwrap(),
                    Message::Binary(b) => ws.send(Message::Binary(b)).await.unwrap(),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        let args = WsArgs { url: format!("ws://127.0.0.1:{port}/"), headers: vec![("X-Token".into(), "abc".into())], protocols: vec!["chat".into()], insecure: false, network: Default::default() };
        let task = tokio::spawn(run_ws("w1".into(), args, rx, collect(&log)));
        tx.send(WsCmd::Text("hi".into())).unwrap();
        tx.send(WsCmd::Binary(vec![1, 2, 3])).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        tx.send(WsCmd::Close).unwrap();
        task.await.unwrap();
        let evs = log.lock().unwrap().clone();
        let types: Vec<_> = evs.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types, ["open", "message", "binary", "close"], "{evs:?}");
        assert_eq!(evs[0]["protocol"], "chat");
        assert_eq!(evs[1]["text"], "echo:hi");
        assert_eq!(evs[2]["size"], 3);
        assert_eq!(evs[3]["code"], 1000);
    }

    #[tokio::test]
    async fn websocket_connect_failure_and_tls_config_errors() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (_tx, rx) = mpsc::unbounded_channel();
        run_ws("w2".into(), WsArgs { url: "ws://127.0.0.1:1/".into(), headers: vec![], protocols: vec![], insecure: false, network: Default::default() }, rx, collect(&log)).await;
        assert_eq!(log.lock().unwrap()[0]["type"], "error");

        assert!(tls_config(true, &Default::default()).is_ok());
        assert!(tls_config(false, &Default::default()).is_ok());
        let bad = NetworkSettings { ca_cert: "/no/such.pem".into(), ..Default::default() };
        assert!(tls_config(false, &bad).unwrap_err().contains("CA certificate"));
    }
}
