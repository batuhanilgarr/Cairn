import { sendRaw } from "./net";
import { parseCurl } from "./curl";
import type { RequestTab, ResponseData } from "./types";

/**
 * The AI assistant talks to an endpoint you configure: an OpenAI-compatible server (OpenAI, OpenRouter, LM Studio, vLLM, Groq, ...)
 * or Ollama's own API. Calls go through the same Rust HTTP layer as your requests, so proxy and CA settings apply.
 */
export type AiFormat = "openai" | "ollama";

export type AiConfig = {
  format: AiFormat;
  /** Server root, e.g. https://ollama.example.com or https://api.openai.com/v1. Pasting a full endpoint URL also works. */
  baseUrl: string;
  /** Optional. Empty means no auth header is sent. */
  token: string;
  authHeader: string;
  /** Prefix before the token ("Bearer"); empty sends the token as is. */
  authScheme: string;
  model: string;
  /** Appends " /no_think" to your message (Qwen3 and friends skip their long reasoning). */
  noThink: boolean;
};

export const DEFAULT_AI: AiConfig = { format: "ollama", baseUrl: "", token: "", authHeader: "Authorization", authScheme: "Bearer", model: "", noThink: false };

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

const ENDPOINT_SUFFIXES = ["/api/generate", "/api/chat", "/api/tags", "/chat/completions", "/completions", "/models"];

/** Server root from whatever was pasted: strips a known endpoint path, the query and trailing slashes. */
export function normalizeBase(input: string, format: AiFormat): string {
  let u = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  for (const s of ENDPOINT_SUFFIXES) {
    if (u.endsWith(s)) {
      u = u.slice(0, -s.length);
      break;
    }
  }
  // OpenAI-style servers live under /v1; a bare host almost always means that
  if (format === "openai" && /^https?:\/\/[^/]+$/i.test(u)) u += "/v1";
  return u;
}

const headersOf = (c: AiConfig): [string, string][] => {
  const h: [string, string][] = [["Content-Type", "application/json"], ["Accept", "application/json"]];
  const token = c.token.trim();
  if (token) h.push([c.authHeader.trim() || "Authorization", `${c.authScheme.trim() ? c.authScheme.trim() + " " : ""}${token}`]);
  return h;
};

function explain(res: ResponseData): string {
  let detail = "";
  try {
    const j = JSON.parse(res.body);
    detail = String(j?.error?.message ?? j?.error ?? j?.message ?? "");
  } catch {
    detail = res.body.slice(0, 200);
  }
  const hint = res.status === 401 || res.status === 403 ? " Check the token and the auth header in Settings > AI." : res.status === 404 ? " Check the endpoint and the model name." : "";
  return `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}.${hint}`;
}

async function call(c: AiConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  if (!c.baseUrl.trim()) throw new Error("Set an AI endpoint in Settings > AI first.");
  const url = normalizeBase(c.baseUrl, c.format) + path;
  const res = await sendRaw({ method, url, headers: headersOf(c), body: body === undefined ? null : JSON.stringify(body), timeoutMs: 300_000, insecure: false, followRedirects: true });
  if (res.status >= 400) throw new Error(explain(res));
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`The server didn't answer with JSON (got "${res.body.slice(0, 80).replace(/\s+/g, " ")}"). Is the endpoint and format right?`);
  }
}

/** Model names the server offers. */
export async function listModels(c: AiConfig): Promise<string[]> {
  const j = await call(c, "GET", c.format === "ollama" ? "/api/tags" : "/models");
  const names: string[] = c.format === "ollama" ? (j.models ?? []).map((m: any) => String(m.name ?? m.model)) : (j.data ?? []).map((m: any) => String(m.id));
  return [...new Set(names)].filter(Boolean).sort();
}

/** One non-streaming chat turn. Returns the assistant's raw text (reasoning included; see splitThinking). */
export async function chat(c: AiConfig, messages: ChatMsg[]): Promise<string> {
  if (!c.model.trim()) throw new Error("Pick a model in Settings > AI first.");
  const msgs = messages.map((m) => ({ ...m }));
  if (c.noThink) {
    const last = [...msgs].reverse().find((m) => m.role === "user");
    if (last && !/\/no_think\s*$/.test(last.content)) last.content += " /no_think";
  }
  if (c.format === "ollama") {
    const j = await call(c, "POST", "/api/chat", { model: c.model.trim(), messages: msgs, stream: false });
    const text = j?.message?.content ?? j?.response;
    if (typeof text !== "string") throw new Error("The server answered, but not in Ollama's chat format. Try the OpenAI-compatible format.");
    return text;
  }
  const j = await call(c, "POST", "/chat/completions", { model: c.model.trim(), messages: msgs, stream: false });
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("The server answered, but not in the OpenAI chat format. Try the Ollama format.");
  return text;
}

/** Reasoning models wrap their thinking in <think>…</think>; show the answer and keep the thinking aside. */
export function splitThinking(text: string): { answer: string; thinking: string } {
  const parts: string[] = [];
  const answer = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, t) => (parts.push(String(t).trim()), "")).replace(/^\s+/, "");
  return { answer, thinking: parts.filter(Boolean).join("\n\n") };
}

/** Fill the settings from a curl command, like the one you already use to call your endpoint. */
export function configFromCurl(command: string): Partial<AiConfig> & { notes: string[] } {
  const { tab } = parseCurl(command);
  const notes: string[] = [];
  const url = tab.url.trim();
  if (!url) throw new Error("That doesn't look like a curl command with a URL.");
  const path = url.replace(/^https?:\/\/[^/]+/i, "");
  const format: AiFormat = /\/api\/(generate|chat|tags)\b/.test(path) ? "ollama" : /\/v1\/|\/chat\/completions|\/models/.test(path) ? "openai" : "ollama";
  const out: Partial<AiConfig> & { notes: string[] } = { format, baseUrl: normalizeBase(url, format), notes };
  try {
    const body = JSON.parse(tab.body);
    if (typeof body?.model === "string") out.model = body.model;
  } catch {
    /* no JSON body: the model is picked from the list */
  }
  const auth = tab.headers.find((h) => h.key && /^(authorization|x-api-key|api-key)$/i.test(h.key) && h.value.trim());
  if (auth) {
    const m = auth.value.trim().match(/^(Bearer|Basic|Token)\s+(.+)$/i);
    out.authHeader = auth.key;
    out.authScheme = m ? m[1] : "";
    out.token = m ? m[2] : auth.value.trim();
  } else {
    out.token = "";
    notes.push("No auth header in the command, so none will be sent.");
  }
  if (/\/no_?think/.test(tab.body)) out.noThink = true;
  return out;
}

/* ------------------------------ what the model is told ------------------------------ */

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$|token|secret|password|passwd|apikey|signature/i;
const SENSITIVE_FIELD = /("[^"]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[^"]*"\s*:\s*)"[^"]*"/gi;
const LIMIT = 6000;

export const redactHeaders = (rows: [string, string][]): [string, string][] => rows.map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? "<hidden>" : v]);

/** Hide values of fields that look like credentials in JSON text, then cut it to a size a model can take. */
export function safeBody(text: string): string {
  const masked = text.replace(SENSITIVE_FIELD, '$1"<hidden>"');
  return masked.length > LIMIT ? `${masked.slice(0, LIMIT)}\n… (${masked.length - LIMIT} more characters not sent)` : masked;
}

export type ContextOptions = { body: boolean; response: boolean };

/**
 * The request (and optionally its last response) as plain text for the model. {{variables}} are NOT resolved and
 * credentials are hidden, so secrets stay on this Mac.
 */
export function buildContext(tab: RequestTab, response: ResponseData | null | undefined, opts: ContextOptions): string {
  const lines: string[] = [];
  lines.push(`Request: ${tab.kind === "graphql" ? "POST (GraphQL)" : tab.method} ${tab.url || "(no URL yet)"}`);
  const headers = redactHeaders(tab.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));
  if (headers.length) lines.push("Headers:", ...headers.map(([k, v]) => `  ${k}: ${v}`));
  if (tab.authMode !== "none") lines.push(`Auth: ${tab.authMode} (credentials are hidden)`);
  if (opts.body) {
    if (tab.kind === "graphql") lines.push("GraphQL query:", safeBody(tab.gql.query), ...(tab.gql.variables.trim() ? ["Variables:", safeBody(tab.gql.variables)] : []));
    else if (tab.bodyMode === "multipart") lines.push("Body (multipart/form-data) fields: " + tab.formParts.filter((p) => p.key).map((p) => `${p.key}${p.kind === "file" ? " (file)" : ""}`).join(", "));
    else if (tab.bodyMode === "binary") lines.push("Body: a file is sent as the raw body");
    else if (tab.bodyMode !== "none" && tab.body.trim()) lines.push(`Body (${tab.bodyMode}):`, safeBody(tab.body));
  }
  if (opts.response && response) {
    lines.push("", `Last response: ${response.status} ${response.statusText} in ${response.timeMs} ms, ${response.sizeBytes} bytes, ${response.contentType || "unknown type"}`);
    const rh = redactHeaders(response.headers.slice(0, 20));
    if (rh.length) lines.push("Response headers:", ...rh.map(([k, v]) => `  ${k}: ${v}`));
    lines.push(response.bodyBase64 || response.bodyId != null ? "Response body: binary or too large, not shown" : "Response body:", ...(response.bodyBase64 || response.bodyId != null ? [] : [safeBody(response.body)]));
  }
  return lines.join("\n");
}

export const SYSTEM_PROMPT = `You are the assistant built into Reqnest, a desktop API client. Help the user understand and debug the HTTP request they have open: explain what the endpoint and its parameters do, find the likely cause of an error, suggest fixes, and write example bodies, test scripts or code.
Be concise and concrete. Answer in the language the user writes in. Use fenced code blocks for code.
Reqnest scripts use test(name, fn) and expect(value).toBe(...); Postman-style pm.test and pm.expect also work. Variables look like {{name}}: their values and any credentials are hidden from you, so don't ask for them.
You only know what is shown below. If you are guessing about a server you can't see, say so.`;

export const systemMessage = (context: string): ChatMsg => ({ role: "system", content: `${SYSTEM_PROMPT}\n\n--- The request the user has open ---\n${context}` });
