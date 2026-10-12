import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentNetwork } from "./net";

export type StreamEvent = { id: string; type: string; [k: string]: any };

const subs = new Map<string, (e: StreamEvent) => void>();
let started: Promise<unknown> | null = null;

/** One global listener fans events out to per-connection handlers. */
export async function subscribe(id: string, fn: (e: StreamEvent) => void) {
  started ??= listen<StreamEvent>("stream", (e) => subs.get(e.payload.id)?.(e.payload));
  await started;
  subs.set(id, fn);
}
export const unsubscribe = (id: string) => subs.delete(id);

export const sseConnect = (id: string, spec: Record<string, unknown>) =>
  invoke("sse_connect", { id, spec: { ...spec, network: currentNetwork() } });

export const wsConnect = (id: string, a: { url: string; headers: [string, string][]; protocols: string[]; insecure: boolean }) =>
  invoke("ws_connect", { id, ...a, network: currentNetwork() });

export const wsSend = (id: string, a: { text?: string; base64?: string }) => invoke("ws_send", { id, text: a.text ?? null, base64: a.base64 ?? null });
export const wsClose = (id: string) => invoke("ws_close", { id });
export const streamStop = (id: string) => invoke("stream_stop", { id });

export type StreamStatus = "idle" | "connecting" | "open" | "closed" | "error";
export type StreamEntry = {
  n: number;
  at: number;
  dir: "in" | "out" | "sys";
  label: string;
  text: string;
  size?: number;
  tone?: "error";
};
export type StreamState = { status: StreamStatus; entries: StreamEntry[]; dropped: number; info: string; sent: number; received: number; startedAt?: number };

export const EMPTY_STREAM: StreamState = { status: "idle", entries: [], dropped: 0, info: "", sent: 0, received: 0 };
export const MAX_ENTRIES = 3000;

/* ------------------------------- gRPC ------------------------------- */

export type GrpcMethod = {
  name: string;
  fullName: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  inputType: string;
  outputType: string;
  template: unknown;
};
export type GrpcService = { name: string; methods: GrpcMethod[] };

export type GrpcSourceArg = { kind: "reflection"; metadata: [string, string][] } | { kind: "proto"; files: string[]; includes: string[] };
export type GrpcTargetArg = { url: string; tls: boolean; insecure: boolean; timeoutMs: number };

export const grpcDescribe = (target: GrpcTargetArg, source: GrpcSourceArg) =>
  invoke<GrpcService[]>("grpc_describe", { target: { ...target, network: currentNetwork() }, source });
export const grpcCall = (id: string, a: { target: GrpcTargetArg; source: GrpcSourceArg; method: string; messages: string[]; metadata: [string, string][] }) =>
  invoke("grpc_call", { id, ...a, target: { ...a.target, network: currentNetwork() } });
export const grpcSend = (id: string, text: string) => invoke("grpc_send", { id, text });
export const grpcEnd = (id: string) => invoke("grpc_end", { id });

export const methodKind = (m: GrpcMethod) => (m.clientStreaming && m.serverStreaming ? "bidi stream" : m.clientStreaming ? "client stream" : m.serverStreaming ? "server stream" : "unary");
