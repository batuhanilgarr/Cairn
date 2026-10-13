import { dynamicValue } from "./dynamic";
import { missingParams, syncParams } from "./query";
import type { Environment, FormPart, KV, OAuthConfig, RequestTab } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10);
export const emptyKV = (): KV => ({ id: uid(), key: "", value: "", enabled: true });

export const defaultOAuth = (): OAuthConfig => ({
  grant: "client_credentials",
  authUrl: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  redirectPort: 8976,
  pkce: true,
  clientAuth: "basic",
  username: "",
  password: "",
  extra: [emptyKV()],
  prefix: "Bearer",
});

let tabDefaults = { timeoutMs: 30000, followRedirects: true, insecure: false };
/** New requests start from the user's Settings > Requests defaults. */
export const setTabDefaults = (d: typeof tabDefaults) => {
  tabDefaults = d;
};

export const defaultGql = () => ({ query: "", variables: "", operation: "" });
export const defaultWs = () => ({ composer: "", messages: [], protocols: "" });
export const defaultGrpc = (): RequestTab["grpc"] => ({ source: "reflection", protoFiles: [], importPaths: [], method: "", message: "{}", tls: true });

export const defaultMcp = (): RequestTab["mcp"] => ({ transport: "http", command: "", args: "", env: [emptyKV()] });

export const emptyPart = (): FormPart => ({ id: uid(), key: "", value: "", enabled: true, kind: "text" });

export const newTab = (): RequestTab => ({
  kind: "http",
  examples: [],
  gql: defaultGql(),
  ws: defaultWs(),
  grpc: defaultGrpc(),
  mcp: defaultMcp(),
  id: uid(),
  name: "New request",
  method: "GET",
  url: "",
  params: [emptyKV()],
  headers: [emptyKV()],
  bodyMode: "none",
  body: "",
  formParts: [emptyPart()],
  authMode: "none",
  authToken: "",
  authUser: "",
  authPass: "",
  insecure: tabDefaults.insecure,
  followRedirects: tabDefaults.followRedirects,
  timeoutMs: tabDefaults.timeoutMs,
  preScript: "",
  postScript: "",
  assertions: [],
  captures: [],
  oauth: defaultOAuth(),
});

/** Fill in fields added by newer versions, so tabs saved by an older build still load. */
export const normalizeTab = (t: Partial<RequestTab>): RequestTab => {
  const base = newTab();
  const merged = { ...base, ...t };
  return {
    ...merged,
    ...syncParams(merged.url, merged.params),
    oauth: { ...base.oauth, ...(t.oauth ?? {}) },
    gql: { ...base.gql, ...(t.gql ?? {}) },
    ws: { ...base.ws, ...(t.ws ?? {}) },
    grpc: { ...base.grpc, ...(t.grpc ?? {}) },
    mcp: { ...base.mcp, ...(t.mcp ?? {}) },
  } as RequestTab;
};

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function interpolate(text: string, env: Environment | undefined): string {
  if (!env) return text;
  const map = new Map(env.vars.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]));
  return text.replace(/\{\{\s*(\$?[\w.\-]+)\s*\}\}/g, (m, k) => (map.has(k) ? map.get(k)! : (dynamicValue(k) ?? m)));
}

export function buildRequest(tab: RequestTab, env: Environment | undefined, extraHeaders: [string, string][] = []) {
  const sub = (s: string) => interpolate(s, env);
  const rawUrl = tab.url.trim();
  let url = sub(rawUrl);
  const params = missingParams(rawUrl, tab.params);
  if (params.length) {
    const qs = params
      .map((p) => `${encodeURIComponent(sub(p.key))}=${encodeURIComponent(sub(p.value))}`)
      .join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  if (tab.kind === "ws") {
    url = url.replace(/^http(s?):\/\//i, "ws$1://");
    if (url && !/^wss?:\/\//i.test(url)) url = "ws://" + url;
  } else if (tab.kind !== "grpc" && url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;

  const headers: [string, string][] = tab.headers
    .filter((h) => h.enabled && h.key)
    .map((h) => [sub(h.key), sub(h.value)]);
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n);

  if (tab.authMode === "bearer" && tab.authToken && !has("authorization"))
    headers.push(["Authorization", `Bearer ${sub(tab.authToken)}`]);
  if (tab.authMode === "basic" && !has("authorization"))
    headers.push(["Authorization", `Basic ${btoa(unescape(encodeURIComponent(`${sub(tab.authUser)}:${sub(tab.authPass)}`)))}`]);

  for (const [k, v] of extraHeaders) if (!has(k.toLowerCase())) headers.push([k, v]);

  let body: string | undefined;
  let multipart: { name: string; value: string; file: boolean; contentType?: string }[] | undefined;
  let bodyFile: string | undefined;
  let method = tab.method;
  if (tab.kind === "graphql") {
    method = "POST";
    const raw = sub(tab.gql.variables).trim();
    let variables: unknown = {};
    if (raw) {
      try {
        variables = JSON.parse(raw);
      } catch (e) {
        throw new Error(`GraphQL variables aren't valid JSON: ${(e as Error).message}`);
      }
    }
    body = JSON.stringify({ query: sub(tab.gql.query), variables, ...(tab.gql.operation.trim() ? { operationName: sub(tab.gql.operation.trim()) } : {}) });
    if (!has("content-type")) headers.push(["Content-Type", "application/json"]);
    if (!has("accept")) headers.push(["Accept", "application/graphql-response+json, application/json"]);
  } else if (tab.bodyMode === "multipart" && !["GET", "HEAD"].includes(tab.method)) {
    multipart = tab.formParts
      .filter((p) => p.enabled && p.key)
      .map((p) => ({ name: sub(p.key), value: sub(p.value), file: p.kind === "file", contentType: p.contentType?.trim() ? sub(p.contentType.trim()) : undefined }));
    // The boundary is generated at send time, so a Content-Type header here would be wrong.
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === "content-type") headers.splice(i, 1);
  } else if (tab.bodyMode === "binary" && !["GET", "HEAD"].includes(tab.method)) {
    bodyFile = sub(tab.body).trim() || undefined;
    if (!has("content-type")) headers.push(["Content-Type", "application/octet-stream"]);
  } else if (tab.bodyMode !== "none" && !["GET", "HEAD"].includes(tab.method)) {
    body = sub(tab.body);
    if (!has("content-type")) {
      if (tab.bodyMode === "json") headers.push(["Content-Type", "application/json"]);
      if (tab.bodyMode === "form") headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
      if (tab.bodyMode === "text") headers.push(["Content-Type", "text/plain"]);
    }
  }
  return {
    method,
    url,
    headers,
    body,
    multipart,
    bodyFile,
    timeoutMs: tab.timeoutMs,
    insecure: tab.insecure,
    followRedirects: tab.followRedirects,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function tryPrettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Indent XML (what SAP Hybris, SOAP and many older APIs return). Returns null when it doesn't look like XML. */
export function tryPrettyXml(src: string): string | null {
  const text = src.trim();
  if (!text.startsWith("<")) return null;
  const tokens = text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]+>|[^<]+/g);
  if (!tokens) return null;
  const out: string[] = [];
  let depth = 0;
  const pad = () => "  ".repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("<")) {
      const s = t.trim();
      if (s) out.push(pad() + s);
      continue;
    }
    if (t.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      out.push(pad() + t);
    } else if (/^<[^!?]/.test(t) && !t.endsWith("/>")) {
      const next = tokens[i + 1];
      const close = tokens[i + 2];
      if (next !== undefined && !next.startsWith("<") && close?.startsWith("</")) {
        out.push(pad() + t + next.trim() + close); // <a>text</a> stays on one line
        i += 2;
      } else {
        out.push(pad() + t);
        depth++;
      }
    } else out.push(pad() + t);
  }
  return out.join("\n");
}

export function highlightJson(src: string): string {
  const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let c = "num";
      if (m.startsWith('"')) c = m.endsWith(":") ? "key" : "str";
      else if (/true|false/.test(m)) c = "bool";
      else if (/null/.test(m)) c = "null";
      return `<span class="j-${c}">${m}</span>`;
    },
  );
}

export function statusClass(s: number): string {
  if (s >= 500) return "s5";
  if (s >= 400) return "s4";
  if (s >= 300) return "s3";
  return "s2";
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** "Today", "Yesterday" or a short date, for grouping history. */
export function dayLabel(t: number, now = new Date()): string {
  const d = new Date(t);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
