//! Dynamic gRPC: no generated code. The schema comes from .proto files (compiled in-process with
//! protox) or from the server's reflection service; messages travel as JSON <-> protobuf.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::metadata::{KeyAndValueRef, MetadataKey, MetadataMap, MetadataValue};
use tonic::transport::{Channel, Endpoint};
use tonic::{Request, Status};

use crate::streams::{Emit, Handle, Streams};
use crate::NetworkSettings;

/* ------------------------------- codec ------------------------------- */

#[derive(Clone)]
pub struct DynCodec {
    pub input: MessageDescriptor,
    pub output: MessageDescriptor,
}

pub struct DynEncoder;
pub struct DynDecoder(MessageDescriptor);

impl Encoder for DynEncoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(&mut self, item: DynamicMessage, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst).map_err(|e| Status::internal(format!("encode: {e}")))
    }
}

impl Decoder for DynDecoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<DynamicMessage>, Status> {
        DynamicMessage::decode(self.0.clone(), src).map(Some).map_err(|e| Status::internal(format!("decode: {e}")))
    }
}

impl Codec for DynCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynEncoder;
    type Decoder = DynDecoder;
    fn encoder(&mut self) -> DynEncoder {
        DynEncoder
    }
    fn decoder(&mut self) -> DynDecoder {
        DynDecoder(self.output.clone())
    }
}

/* ------------------------------- schema ------------------------------- */

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub url: String,
    pub tls: bool,
    pub insecure: bool,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub network: NetworkSettings,
}

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Reflection {
        #[serde(default)]
        metadata: Vec<(String, String)>,
    },
    Proto {
        files: Vec<String>,
        #[serde(default)]
        includes: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodInfo {
    pub name: String,
    pub full_name: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    pub input_type: String,
    pub output_type: String,
    pub template: Value,
}

#[derive(Serialize)]
pub struct ServiceInfo {
    pub name: String,
    pub methods: Vec<MethodInfo>,
}

fn json_options() -> SerializeOptions {
    SerializeOptions::new().skip_default_fields(false).stringify_64_bit_integers(true)
}

pub fn message_to_json(m: &DynamicMessage) -> Result<Value, String> {
    m.serialize_with_options(serde_json::value::Serializer, &json_options()).map_err(|e| e.to_string())
}

pub fn json_to_message(desc: &MessageDescriptor, text: &str) -> Result<DynamicMessage, String> {
    let text = if text.trim().is_empty() { "{}" } else { text };
    let mut de = serde_json::Deserializer::from_str(text);
    let m = DynamicMessage::deserialize(desc.clone(), &mut de).map_err(|e| format!("Request JSON doesn't match {}: {e}", desc.full_name()))?;
    de.end().map_err(|e| format!("Request JSON: {e}"))?;
    Ok(m)
}

pub fn load_proto(files: &[String], includes: &[String]) -> Result<DescriptorPool, String> {
    if files.is_empty() {
        return Err("Add at least one .proto file".into());
    }
    let mut inc: Vec<std::path::PathBuf> = includes.iter().filter(|s| !s.trim().is_empty()).map(Into::into).collect();
    if inc.is_empty() {
        for f in files {
            if let Some(dir) = std::path::Path::new(f).parent() {
                if !inc.iter().any(|d| d == dir) {
                    inc.push(dir.to_path_buf());
                }
            }
        }
    }
    let mut c = protox::Compiler::new(&inc).map_err(|e| format!("{e}"))?;
    c.include_imports(true);
    c.open_files(files.iter().map(|f| {
        // files are resolved relative to an include path, so pass the path relative to whichever include contains it
        inc.iter().find_map(|d| std::path::Path::new(f).strip_prefix(d).ok().map(|p| p.to_path_buf())).unwrap_or_else(|| f.into())
    }))
    .map_err(|e| format!("{e}"))?;
    DescriptorPool::from_file_descriptor_set(c.file_descriptor_set()).map_err(|e| format!("{e}"))
}

pub fn services_of(pool: &DescriptorPool) -> Vec<ServiceInfo> {
    let mut out: Vec<ServiceInfo> = pool
        .services()
        .filter(|s| !s.full_name().starts_with("grpc.reflection."))
        .map(|s| ServiceInfo {
            name: s.full_name().to_string(),
            methods: s
                .methods()
                .map(|m| MethodInfo {
                    name: m.name().to_string(),
                    full_name: format!("{}/{}", s.full_name(), m.name()),
                    client_streaming: m.is_client_streaming(),
                    server_streaming: m.is_server_streaming(),
                    input_type: m.input().full_name().to_string(),
                    output_type: m.output().full_name().to_string(),
                    template: message_to_json(&DynamicMessage::new(m.input())).unwrap_or(json!({})),
                })
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn find_method(pool: &DescriptorPool, full: &str) -> Result<MethodDescriptor, String> {
    let (svc, name) = full.split_once('/').ok_or("Pick a method first")?;
    pool.get_service_by_name(svc)
        .ok_or_else(|| format!("Unknown service {svc}"))?
        .methods()
        .find(|m| m.name() == name)
        .ok_or_else(|| format!("Unknown method {full}"))
}

/* ------------------------------ connection ------------------------------ */

fn split_target(t: &Target) -> (bool, String) {
    let u = t.url.trim();
    let (scheme, rest) = u.split_once("://").map(|(s, r)| (s.to_lowercase(), r)).unwrap_or((String::new(), u));
    let authority = rest.split('/').next().unwrap_or(rest).to_string();
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(&authority).trim_matches(|c| c == '[' || c == ']');
    // Without a scheme, local servers are almost always plaintext; everything else follows the TLS setting.
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    let tls = match scheme.as_str() {
        "grpcs" | "https" => true,
        "grpc" | "http" => false,
        _ => t.tls && !loopback,
    };
    (tls, authority)
}

pub async fn connect(t: &Target) -> Result<Channel, String> {
    let (tls, authority) = split_target(t);
    if authority.is_empty() {
        return Err("Enter the server address, e.g. localhost:50051".into());
    }
    let limit = Duration::from_millis(if t.timeout_ms == 0 { 30_000 } else { t.timeout_ms });
    let ep = Endpoint::from_shared(format!("{}://{}", if tls { "https" } else { "http" }, authority))
        .map_err(|e| format!("Invalid address: {e}"))?
        .connect_timeout(limit)
        .tcp_nodelay(true);
    let res = if tls {
        let mut cfg = crate::streams::tls_config(t.insecure, &t.network)?;
        cfg.alpn_protocols = vec![b"h2".to_vec()];
        let https = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(cfg).https_only().enable_http2().build();
        ep.connect_with_connector(https).await
    } else {
        ep.connect().await
    };
    res.map_err(|e| {
        let mut m = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            m.push_str(&format!(": {s}"));
            src = s.source();
        }
        let hint = if m.to_lowercase().contains("refused") {
            ""
        } else if tls {
            "\nIf this server doesn't use TLS, prefix the address with grpc:// (e.g. grpc://localhost:50051)."
        } else {
            "\nIf this server requires TLS, prefix the address with grpcs://."
        };
        format!("Couldn't connect to {authority}: {m}{hint}")
    })
}

fn apply_metadata(meta: &mut MetadataMap, pairs: &[(String, String)]) -> Result<(), String> {
    use base64::Engine;
    for (k, v) in pairs.iter().filter(|(k, _)| !k.trim().is_empty()) {
        let key = k.trim().to_lowercase();
        if key.ends_with("-bin") {
            let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(v.trim().trim_end_matches('='))
                .map_err(|e| format!("Metadata {key}: not valid base64 ({e})"))?;
            meta.insert_bin(MetadataKey::from_bytes(key.as_bytes()).map_err(|e| format!("Metadata key {key}: {e}"))?, MetadataValue::from_bytes(&bytes));
        } else {
            meta.insert(
                MetadataKey::from_bytes(key.as_bytes()).map_err(|e| format!("Metadata key {key}: {e}"))?,
                v.trim().parse::<MetadataValue<_>>().map_err(|e| format!("Metadata {key}: {e}"))?,
            );
        }
    }
    Ok(())
}

fn metadata_json(meta: &MetadataMap) -> Value {
    use base64::Engine;
    Value::Array(
        meta.iter()
            .map(|kv| match kv {
                KeyAndValueRef::Ascii(k, v) => json!([k.as_str(), v.to_str().unwrap_or("")]),
                KeyAndValueRef::Binary(k, v) => json!([k.as_str(), base64::engine::general_purpose::STANDARD.encode(v.as_encoded_bytes())]),
            })
            .collect(),
    )
}

/* ------------------------------- reflection ------------------------------- */

use tonic_reflection::pb::v1::{server_reflection_client::ServerReflectionClient, server_reflection_request::MessageRequest, server_reflection_response::MessageResponse, ServerReflectionRequest};

async fn reflect_v1(channel: Channel, metadata: &[(String, String)]) -> Result<DescriptorPool, String> {
    let mut client = ServerReflectionClient::new(channel);
    let (tx, rx) = mpsc::unbounded_channel::<ServerReflectionRequest>();
    let req = |m: MessageRequest| ServerReflectionRequest { host: String::new(), message_request: Some(m) };
    tx.send(req(MessageRequest::ListServices(String::new()))).ok();
    let mut request = Request::new(tokio_stream::wrappers::UnboundedReceiverStream::new(rx));
    apply_metadata(request.metadata_mut(), metadata)?;
    let mut resp = client
        .server_reflection_info(request)
        .await
        .map_err(|s| format!("{}: {}", crate::grpc::code_name(s.code()), s.message()))?
        .into_inner();

    let mut services: Vec<String> = Vec::new();
    let mut protos: HashMap<String, prost_types::FileDescriptorProto> = HashMap::new();
    let mut asked: HashSet<String> = HashSet::new();
    let mut pending = 0usize;

    let add_files = |bytes: Vec<Vec<u8>>, protos: &mut HashMap<String, prost_types::FileDescriptorProto>| -> Result<(), String> {
        for b in bytes {
            let f = prost_types::FileDescriptorProto::decode(b.as_slice()).map_err(|e| format!("Bad descriptor from server: {e}"))?;
            protos.entry(f.name().to_string()).or_insert(f);
        }
        Ok(())
    };

    while let Some(msg) = tokio::time::timeout(Duration::from_secs(15), resp.message())
        .await
        .map_err(|_| "Timed out waiting for the server's reflection reply".to_string())?
        .map_err(|s| format!("{}: {}", code_name(s.code()), s.message()))?
    {
        match msg.message_response {
            Some(MessageResponse::ListServicesResponse(l)) => {
                services = l.service.into_iter().map(|s| s.name).filter(|n| !n.starts_with("grpc.reflection.")).collect();
                for s in &services {
                    pending += 1;
                    tx.send(req(MessageRequest::FileContainingSymbol(s.clone()))).ok();
                }
                if services.is_empty() {
                    break;
                }
            }
            Some(MessageResponse::FileDescriptorResponse(f)) => {
                pending = pending.saturating_sub(1);
                add_files(f.file_descriptor_proto, &mut protos)?;
                // ask for any dependency the server didn't include
                let missing: Vec<String> = protos
                    .values()
                    .flat_map(|p| p.dependency.iter().cloned())
                    .filter(|d| !protos.contains_key(d) && !asked.contains(d))
                    .collect();
                for d in missing {
                    asked.insert(d.clone());
                    pending += 1;
                    tx.send(req(MessageRequest::FileByFilename(d))).ok();
                }
                if pending == 0 {
                    break;
                }
            }
            Some(MessageResponse::ErrorResponse(e)) => {
                pending = pending.saturating_sub(1);
                if pending == 0 && protos.is_empty() {
                    return Err(format!("Server reflection error: {}", e.error_message));
                }
                if pending == 0 {
                    break;
                }
            }
            _ => {}
        }
    }
    drop(tx);
    if services.is_empty() {
        return Err("The server reports no services".into());
    }
    // topological order: dependencies first
    let mut ordered = Vec::new();
    let mut done: HashSet<String> = HashSet::new();
    fn visit(name: &str, protos: &HashMap<String, prost_types::FileDescriptorProto>, done: &mut HashSet<String>, out: &mut Vec<prost_types::FileDescriptorProto>) {
        if !done.insert(name.to_string()) {
            return;
        }
        if let Some(p) = protos.get(name) {
            for d in &p.dependency {
                visit(d, protos, done, out);
            }
            out.push(p.clone());
        }
    }
    let names: Vec<String> = protos.keys().cloned().collect();
    for n in names {
        visit(&n, &protos, &mut done, &mut ordered);
    }
    DescriptorPool::from_file_descriptor_set(prost_types::FileDescriptorSet { file: ordered }).map_err(|e| format!("Couldn't assemble the server's schema: {e}"))
}

/* --------------------------------- state --------------------------------- */

#[derive(Default, Clone)]
pub struct Pools(Arc<Mutex<HashMap<String, DescriptorPool>>>);

fn pool_key(t: &Target, s: &Source) -> String {
    match s {
        Source::Reflection { .. } => format!("refl|{}|{}", t.url.trim(), t.tls),
        Source::Proto { files, includes } => format!("proto|{}|{}", files.join(","), includes.join(",")),
    }
}

async fn load_pool(t: &Target, s: &Source, pools: &Pools, refresh: bool) -> Result<DescriptorPool, String> {
    let key = pool_key(t, s);
    if !refresh {
        if let Some(p) = pools.0.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
    }
    let pool = match s {
        Source::Proto { files, includes } => load_proto(files, includes)?,
        Source::Reflection { metadata } => {
            let ch = connect(t).await?;
            match reflect_v1(ch.clone(), metadata).await {
                Ok(p) => p,
                Err(e) if e.contains("Unimplemented") || e.contains("Unknown service") => {
                    return Err(format!("This server doesn't offer reflection ({e}). Use .proto files instead."));
                }
                Err(e) => return Err(e),
            }
        }
    };
    pools.0.lock().unwrap().insert(key, pool.clone());
    Ok(pool)
}

pub fn code_name(c: tonic::Code) -> &'static str {
    use tonic::Code::*;
    match c {
        Ok => "OK",
        Cancelled => "CANCELLED",
        Unknown => "UNKNOWN",
        InvalidArgument => "INVALID_ARGUMENT",
        DeadlineExceeded => "DEADLINE_EXCEEDED",
        NotFound => "NOT_FOUND",
        AlreadyExists => "ALREADY_EXISTS",
        PermissionDenied => "PERMISSION_DENIED",
        ResourceExhausted => "RESOURCE_EXHAUSTED",
        FailedPrecondition => "FAILED_PRECONDITION",
        Aborted => "ABORTED",
        OutOfRange => "OUT_OF_RANGE",
        Unimplemented => "UNIMPLEMENTED",
        Internal => "INTERNAL",
        Unavailable => "UNAVAILABLE",
        DataLoss => "DATA_LOSS",
        Unauthenticated => "UNAUTHENTICATED",
    }
}

/* ---------------------------------- calls ---------------------------------- */

pub enum GrpcCmd {
    Send(String),
    /// Half-close: no more client messages.
    End,
}

pub struct CallArgs {
    pub target: Target,
    pub method: String,
    pub messages: Vec<String>,
    pub metadata: Vec<(String, String)>,
}

pub async fn run_call(id: String, args: CallArgs, pool: DescriptorPool, mut cmds: mpsc::UnboundedReceiver<GrpcCmd>, emit: Emit) {
    let ev = |v: Value| {
        let mut v = v;
        v["id"] = json!(id);
        emit(v)
    };
    let started = Instant::now();
    let close_ok = |trailers: Value| json!({"type": "close", "code": 0, "codeName": "OK", "message": "", "trailers": trailers, "ms": started.elapsed().as_millis() as u64});
    let close_status = |s: &Status| json!({"type": "close", "code": s.code() as i32, "codeName": code_name(s.code()), "message": s.message(), "trailers": metadata_json(s.metadata()), "ms": started.elapsed().as_millis() as u64});

    let method = match find_method(&pool, &args.method) {
        Ok(m) => m,
        Err(e) => return ev(json!({"type": "error", "message": e})),
    };
    let (input, output) = (method.input(), method.output());
    let mut initial = Vec::new();
    for m in &args.messages {
        match json_to_message(&input, m) {
            Ok(m) => initial.push(m),
            Err(e) => return ev(json!({"type": "error", "message": e})),
        }
    }
    if !method.is_client_streaming() && initial.len() != 1 {
        // a unary / server-streaming call needs exactly one request message
        if initial.is_empty() {
            initial.push(DynamicMessage::new(input.clone()));
        } else {
            return ev(json!({"type": "error", "message": "This method takes a single request message"}));
        }
    }

    let channel = match connect(&args.target).await {
        Ok(c) => c,
        Err(e) => return ev(json!({"type": "error", "message": e})),
    };
    let mut grpc = tonic::client::Grpc::new(channel).max_decoding_message_size(64 * 1024 * 1024);
    if let Err(e) = grpc.ready().await {
        return ev(json!({"type": "error", "message": format!("Connection not ready: {e}")}));
    }
    let path: http::uri::PathAndQuery = match format!("/{}/{}", method.parent_service().full_name(), method.name()).parse() {
        Ok(p) => p,
        Err(e) => return ev(json!({"type": "error", "message": format!("Bad method path: {e}")})),
    };
    let codec = DynCodec { input: input.clone(), output: output.clone() };
    let timeout = if args.target.timeout_ms == 0 { None } else { Some(Duration::from_millis(args.target.timeout_ms)) };

    macro_rules! decorate {
        ($req:expr) => {{
            let mut r = $req;
            if let Err(e) = apply_metadata(r.metadata_mut(), &args.metadata) {
                return ev(json!({"type": "error", "message": e}));
            }
            if let Some(t) = timeout {
                r.set_timeout(t);
            }
            r
        }};
    }
    let msg_event = |m: &DynamicMessage| -> Value {
        let v = message_to_json(m).unwrap_or(Value::Null);
        json!({"type": "message", "text": serde_json::to_string_pretty(&v).unwrap_or_default(), "size": m.encoded_len()})
    };

    if method.is_client_streaming() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<DynamicMessage>();
        for m in initial {
            out_tx.send(m).ok();
        }
        // Forward later messages from the UI until it half-closes.
        let fwd_input = input.clone();
        let fwd_emit = emit.clone();
        let fwd_id = id.clone();
        let forward = tokio::spawn(async move {
            let mut out_tx = Some(out_tx);
            while let Some(cmd) = cmds.recv().await {
                match cmd {
                    GrpcCmd::Send(text) => match json_to_message(&fwd_input, &text) {
                        Ok(m) => {
                            if let Some(tx) = &out_tx {
                                tx.send(m).ok();
                            }
                        }
                        Err(e) => fwd_emit(json!({"id": fwd_id, "type": "warn", "message": e})),
                    },
                    GrpcCmd::End => out_tx = None,
                }
            }
        });
        let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(out_rx);
        let request = decorate!(Request::new(stream));
        if method.is_server_streaming() {
            match grpc.streaming(request, path, codec).await {
                Ok(resp) => {
                    ev(json!({"type": "open", "headers": metadata_json(resp.metadata())}));
                    let mut body = resp.into_inner();
                    loop {
                        match body.message().await {
                            Ok(Some(m)) => ev(msg_event(&m)),
                            Ok(None) => break,
                            Err(s) => {
                                forward.abort();
                                return ev(close_status(&s));
                            }
                        }
                    }
                    let tr = body.trailers().await.ok().flatten().map(|t| metadata_json(&t)).unwrap_or(json!([]));
                    ev(close_ok(tr));
                }
                Err(s) => ev(close_status(&s)),
            }
        } else {
            match grpc.client_streaming(request, path, codec).await {
                Ok(resp) => {
                    ev(json!({"type": "open", "headers": metadata_json(resp.metadata())}));
                    ev(msg_event(resp.get_ref()));
                    ev(close_ok(metadata_json(resp.metadata())));
                }
                Err(s) => ev(close_status(&s)),
            }
        }
        forward.abort();
        return;
    }

    let request = decorate!(Request::new(initial.remove(0)));
    if method.is_server_streaming() {
        match grpc.server_streaming(request, path, codec).await {
            Ok(resp) => {
                ev(json!({"type": "open", "headers": metadata_json(resp.metadata())}));
                let mut body = resp.into_inner();
                loop {
                    match body.message().await {
                        Ok(Some(m)) => ev(msg_event(&m)),
                        Ok(None) => break,
                        Err(s) => return ev(close_status(&s)),
                    }
                }
                let tr = body.trailers().await.ok().flatten().map(|t| metadata_json(&t)).unwrap_or(json!([]));
                ev(close_ok(tr));
            }
            Err(s) => ev(close_status(&s)),
        }
    } else {
        match grpc.unary(request, path, codec).await {
            Ok(resp) => {
                ev(json!({"type": "open", "headers": metadata_json(resp.metadata())}));
                ev(msg_event(resp.get_ref()));
                ev(close_ok(metadata_json(resp.metadata())));
            }
            Err(s) => ev(close_status(&s)),
        }
    }
}

/* ----------------------------- Tauri commands ----------------------------- */

use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn grpc_describe(pools: State<'_, Pools>, target: Target, source: Source) -> Result<Vec<ServiceInfo>, String> {
    let pool = load_pool(&target, &source, pools.inner(), true).await?;
    Ok(services_of(&pool))
}

#[tauri::command]
pub async fn grpc_call(
    app: AppHandle,
    streams: State<'_, Streams>,
    pools: State<'_, Pools>,
    id: String,
    target: Target,
    source: Source,
    method: String,
    messages: Vec<String>,
    metadata: Vec<(String, String)>,
) -> Result<(), String> {
    let pool = load_pool(&target, &source, pools.inner(), false).await?;
    let s = streams.inner().clone();
    let emit: Emit = Arc::new(move |v| {
        let _ = app.emit("stream", v);
    });
    let (tx, rx) = mpsc::unbounded_channel();
    let sid = id.clone();
    let task = tokio::spawn(async move {
        run_call(sid.clone(), CallArgs { target, method, messages, metadata }, pool, rx, emit).await;
        s.remove(&sid);
    });
    streams.put(&id, Handle::Grpc { tx, abort: task.abort_handle() });
    Ok(())
}

#[tauri::command]
pub fn grpc_send(streams: State<'_, Streams>, id: String, text: String) -> Result<(), String> {
    streams.grpc_cmd(&id, GrpcCmd::Send(text))
}

#[tauri::command]
pub fn grpc_end(streams: State<'_, Streams>, id: String) -> Result<(), String> {
    streams.grpc_cmd(&id, GrpcCmd::End)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use futures_util::StreamExt;
    use prost_reflect::Value;
    use std::convert::Infallible;
    use std::task::{Context, Poll};
    use tonic::server::{ClientStreamingService, ServerStreamingService, StreamingService, UnaryService};
    use tonic::Streaming;

    const PROTO: &str = r#"
syntax = "proto3";
package test;
service Echo {
  rpc Say(SayRequest) returns (SayReply);
  rpc Count(CountRequest) returns (stream CountReply);
  rpc Collect(stream SayRequest) returns (SayReply);
  rpc Chat(stream SayRequest) returns (stream SayReply);
}
message SayRequest { string name = 1; int64 big = 2; repeated string tags = 3; }
message SayReply { string greeting = 1; string token = 2; int64 big = 3; }
message CountRequest { int32 n = 1; }
message CountReply { int32 i = 1; }
"#;

    fn proto_file(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("reqnest-grpc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("echo.proto");
        std::fs::write(&f, PROTO).unwrap();
        f.to_string_lossy().to_string()
    }

    fn get_str(m: &DynamicMessage, f: &str) -> String {
        m.get_field_by_name(f).and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
    }
    fn reply(desc: &MessageDescriptor, greeting: String, token: String, big: i64) -> DynamicMessage {
        let mut m = DynamicMessage::new(desc.clone());
        m.set_field_by_name("greeting", Value::String(greeting));
        m.set_field_by_name("token", Value::String(token));
        m.set_field_by_name("big", Value::I64(big));
        m
    }

    #[derive(Clone)]
    struct TestSvc(DescriptorPool);
    impl tonic::server::NamedService for TestSvc {
        const NAME: &'static str = "test.Echo";
    }

    struct Say(MethodDescriptor);
    impl UnaryService<DynamicMessage> for Say {
        type Response = DynamicMessage;
        type Future = BoxFuture<'static, Result<tonic::Response<DynamicMessage>, Status>>;
        fn call(&mut self, req: Request<DynamicMessage>) -> Self::Future {
            let out = self.0.output();
            Box::pin(async move {
                let token = req.metadata().get("x-token").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let name = get_str(req.get_ref(), "name");
                if name == "fail" {
                    return Err(Status::not_found("no such user"));
                }
                let big = req.get_ref().get_field_by_name("big").and_then(|v| v.as_i64()).unwrap_or(0);
                Ok(tonic::Response::new(reply(&out, format!("hello {name}"), token, big)))
            })
        }
    }
    struct Count(MethodDescriptor);
    impl ServerStreamingService<DynamicMessage> for Count {
        type Response = DynamicMessage;
        type ResponseStream = futures_util::stream::BoxStream<'static, Result<DynamicMessage, Status>>;
        type Future = BoxFuture<'static, Result<tonic::Response<Self::ResponseStream>, Status>>;
        fn call(&mut self, req: Request<DynamicMessage>) -> Self::Future {
            let out = self.0.output();
            Box::pin(async move {
                let n = req.get_ref().get_field_by_name("n").and_then(|v| v.as_i32()).unwrap_or(0);
                let s = tokio_stream::iter((1..=n).map(move |i| {
                    let mut m = DynamicMessage::new(out.clone());
                    m.set_field_by_name("i", Value::I32(i));
                    Ok(m)
                }));
                Ok(tonic::Response::new(s.boxed()))
            })
        }
    }
    struct Collect(MethodDescriptor);
    impl ClientStreamingService<DynamicMessage> for Collect {
        type Response = DynamicMessage;
        type Future = BoxFuture<'static, Result<tonic::Response<DynamicMessage>, Status>>;
        fn call(&mut self, req: Request<Streaming<DynamicMessage>>) -> Self::Future {
            let out = self.0.output();
            Box::pin(async move {
                let mut s = req.into_inner();
                let mut names = vec![];
                while let Some(m) = s.message().await? {
                    names.push(get_str(&m, "name"));
                }
                Ok(tonic::Response::new(reply(&out, format!("got {}: {}", names.len(), names.join(",")), String::new(), 0)))
            })
        }
    }
    struct Chat(MethodDescriptor);
    impl StreamingService<DynamicMessage> for Chat {
        type Response = DynamicMessage;
        type ResponseStream = futures_util::stream::BoxStream<'static, Result<DynamicMessage, Status>>;
        type Future = BoxFuture<'static, Result<tonic::Response<Self::ResponseStream>, Status>>;
        fn call(&mut self, req: Request<Streaming<DynamicMessage>>) -> Self::Future {
            let out = self.0.output();
            Box::pin(async move {
                let s = req.into_inner().map(move |m| m.map(|m| reply(&out, format!("echo {}", get_str(&m, "name")), String::new(), 0)));
                Ok(tonic::Response::new(s.boxed()))
            })
        }
    }

    impl tower::Service<http::Request<tonic::body::Body>> for TestSvc {
        type Response = http::Response<tonic::body::Body>;
        type Error = Infallible;
        type Future = BoxFuture<'static, Result<Self::Response, Infallible>>;
        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, req: http::Request<tonic::body::Body>) -> Self::Future {
            let svc = self.0.get_service_by_name("test.Echo").unwrap();
            let name = req.uri().path().trim_start_matches("/test.Echo/").to_string();
            let Some(m) = svc.methods().find(|m| m.name() == name) else {
                return Box::pin(async { Ok(Status::unimplemented("no such method").into_http()) });
            };
            // server side: requests decode with the *input* type, so swap the codec's roles
            let codec = DynCodec { input: m.output(), output: m.input() };
            let mut g = tonic::server::Grpc::new(codec);
            match name.as_str() {
                "Say" => Box::pin(async move { Ok(g.unary(Say(m), req).await) }),
                "Count" => Box::pin(async move { Ok(g.server_streaming(Count(m), req).await) }),
                "Collect" => Box::pin(async move { Ok(g.client_streaming(Collect(m), req).await) }),
                _ => Box::pin(async move { Ok(g.streaming(Chat(m), req).await) }),
            }
        }
    }

    async fn start_server(pool: DescriptorPool) -> u16 {
        let refl = tonic_reflection::server::Builder::configure().register_encoded_file_descriptor_set(&pool.encode_to_vec()).build_v1().unwrap();
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(TestSvc(pool))
                .add_service(refl)
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(l)),
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        port
    }

    fn target(port: u16) -> Target {
        Target { url: format!("127.0.0.1:{port}"), tls: false, insecure: false, timeout_ms: 5000, network: Default::default() }
    }
    fn collect_emit() -> (Emit, Arc<Mutex<Vec<Value2>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        (Arc::new(move |v| l.lock().unwrap().push(v)), log)
    }
    type Value2 = serde_json::Value;

    async fn call(port: u16, pool: &DescriptorPool, method: &str, msgs: &[&str], meta: &[(&str, &str)], later: Vec<GrpcCmd>) -> Vec<Value2> {
        let (emit, log) = collect_emit();
        let (tx, rx) = mpsc::unbounded_channel();
        for c in later {
            tx.send(c).unwrap();
        }
        let args = CallArgs { target: target(port), method: method.into(), messages: msgs.iter().map(|s| s.to_string()).collect(), metadata: meta.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        tokio::time::timeout(Duration::from_secs(10), run_call("c".into(), args, pool.clone(), rx, emit)).await.expect("call timed out");
        drop(tx);
        let v = log.lock().unwrap().clone();
        v
    }
    fn types(v: &[Value2]) -> Vec<String> {
        v.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
    }
    fn msg(e: &Value2) -> Value2 {
        serde_json::from_str(e["text"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn proto_files_become_services_with_json_templates() {
        let pool = load_proto(&[proto_file("tpl")], &[]).unwrap();
        let svcs = services_of(&pool);
        assert_eq!(svcs.len(), 1);
        let say = svcs[0].methods.iter().find(|m| m.name == "Say").unwrap();
        assert_eq!(say.full_name, "test.Echo/Say");
        assert!(!say.client_streaming && !say.server_streaming);
        assert_eq!(say.template, json!({"name": "", "big": "0", "tags": []})); // int64 as string, per proto3 JSON
        let chat = svcs[0].methods.iter().find(|m| m.name == "Chat").unwrap();
        assert!(chat.client_streaming && chat.server_streaming);
        assert!(load_proto(&[], &[]).is_err());
        assert!(load_proto(&["/no/such.proto".into()], &[]).unwrap_err().len() > 3);
    }

    #[test]
    fn json_validation_gives_helpful_errors() {
        let pool = load_proto(&[proto_file("val")], &[]).unwrap();
        let d = pool.get_message_by_name("test.SayRequest").unwrap();
        assert!(json_to_message(&d, r#"{"name":"a","bogus":1}"#).is_err());
        assert!(json_to_message(&d, "{not json").is_err());
        assert!(json_to_message(&d, "").is_ok()); // empty means defaults
        let m = json_to_message(&d, r#"{"name":"a","big":"9007199254740993"}"#).unwrap();
        assert_eq!(message_to_json(&m).unwrap()["big"], "9007199254740993"); // no precision loss
    }

    #[tokio::test]
    async fn unary_call_with_metadata_and_big_ints() {
        let pool = load_proto(&[proto_file("u")], &[]).unwrap();
        let port = start_server(pool.clone()).await;
        let ev = call(port, &pool, "test.Echo/Say", &[r#"{"name":"ada","big":"9007199254740993"}"#], &[("x-token", "s3cret")], vec![]).await;
        assert_eq!(types(&ev), ["open", "message", "close"], "{ev:?}");
        let m = msg(&ev[1]);
        assert_eq!(m["greeting"], "hello ada");
        assert_eq!(m["token"], "s3cret");
        assert_eq!(m["big"], "9007199254740993");
        assert_eq!(ev[2]["code"], 0);
        assert_eq!(ev[2]["codeName"], "OK");
    }

    #[tokio::test]
    async fn error_status_is_reported_with_its_code() {
        let pool = load_proto(&[proto_file("e")], &[]).unwrap();
        let port = start_server(pool.clone()).await;
        let ev = call(port, &pool, "test.Echo/Say", &[r#"{"name":"fail"}"#], &[], vec![]).await;
        let last = ev.last().unwrap();
        assert_eq!(last["type"], "close");
        assert_eq!(last["codeName"], "NOT_FOUND");
        assert_eq!(last["message"], "no such user");
        let ev = call(port, &pool, "test.Echo/Nope", &[], &[], vec![]).await;
        assert_eq!(ev[0]["type"], "error");
    }

    #[tokio::test]
    async fn streaming_in_all_directions() {
        let pool = load_proto(&[proto_file("s")], &[]).unwrap();
        let port = start_server(pool.clone()).await;

        let ev = call(port, &pool, "test.Echo/Count", &[r#"{"n":3}"#], &[], vec![]).await;
        assert_eq!(types(&ev), ["open", "message", "message", "message", "close"]);
        assert_eq!(msg(&ev[3])["i"], 3);

        let ev = call(port, &pool, "test.Echo/Collect", &[r#"{"name":"a"}"#], &[], vec![GrpcCmd::Send(r#"{"name":"b"}"#.into()), GrpcCmd::End]).await;
        assert_eq!(msg(&ev[1])["greeting"], "got 2: a,b", "{ev:?}");
        assert_eq!(ev.last().unwrap()["code"], 0);

        let ev = call(port, &pool, "test.Echo/Chat", &[r#"{"name":"x"}"#], &[], vec![GrpcCmd::Send(r#"{"name":"y"}"#.into()), GrpcCmd::End]).await;
        let greetings: Vec<String> = ev.iter().filter(|e| e["type"] == "message").map(|e| msg(e)["greeting"].as_str().unwrap().to_string()).collect();
        assert_eq!(greetings, ["echo x", "echo y"], "{ev:?}");
    }

    #[tokio::test]
    async fn reflection_discovers_the_same_schema_as_the_proto_file() {
        let pool = load_proto(&[proto_file("r")], &[]).unwrap();
        let port = start_server(pool.clone()).await;
        let refl = load_pool(&target(port), &Source::Reflection { metadata: vec![] }, &Pools::default(), true).await.unwrap();
        let (a, b) = (services_of(&pool), services_of(&refl));
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1, "reflection service itself must be hidden");
        assert_eq!(a[0].methods.len(), b[0].methods.len());
        // and the discovered schema can be used for a real call
        let ev = call(port, &refl, "test.Echo/Say", &[r#"{"name":"via-reflection"}"#], &[], vec![]).await;
        assert_eq!(msg(&ev[1])["greeting"], "hello via-reflection");
    }

    #[tokio::test]
    async fn connection_errors_are_readable() {
        let pool = load_proto(&[proto_file("c")], &[]).unwrap();
        let ev = call(1, &pool, "test.Echo/Say", &[r#"{"name":"a"}"#], &[], vec![]).await;
        assert_eq!(ev[0]["type"], "error");
        assert!(ev[0]["message"].as_str().unwrap().contains("Couldn't connect to 127.0.0.1:1"), "{ev:?}");
        let (tls, auth) = split_target(&Target { url: "grpcs://api.example.com:443/ignored".into(), tls: false, insecure: false, timeout_ms: 0, network: Default::default() });
        assert!(tls && auth == "api.example.com:443");
        let bare = |u: &str, tls: bool| split_target(&Target { url: u.into(), tls, insecure: false, timeout_ms: 0, network: Default::default() }).0;
        assert!(!bare("localhost:50051", true), "loopback defaults to plaintext");
        assert!(!bare("[::1]:50051", true));
        assert!(bare("api.example.com:443", true), "remote hosts follow the TLS setting");
        assert!(!bare("api.example.com:443", false));
        assert!(bare("grpcs://localhost:50051", false), "an explicit scheme always wins");
    }
}
