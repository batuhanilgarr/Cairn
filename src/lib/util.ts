import type { Environment, KV, OAuthConfig, RequestTab } from "./types";

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

export const newTab = (): RequestTab => ({
  kind: "http",
  gql: defaultGql(),
  ws: defaultWs(),
  grpc: defaultGrpc(),
  id: uid(),
  name: "New request",
  method: "GET",
  url: "",
  params: [emptyKV()],
  headers: [emptyKV()],
  bodyMode: "none",
  body: "",
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
  return {
    ...base,
    ...t,
    oauth: { ...base.oauth, ...(t.oauth ?? {}) },
    gql: { ...base.gql, ...(t.gql ?? {}) },
    ws: { ...base.ws, ...(t.ws ?? {}) },
    grpc: { ...base.grpc, ...(t.grpc ?? {}) },
  } as RequestTab;
};

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function interpolate(text: string, env: Environment | undefined): string {
  if (!env) return text;
  const map = new Map(env.vars.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]));
  return text.replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (m, k) => (map.has(k) ? map.get(k)! : m));
}

export function buildRequest(tab: RequestTab, env: Environment | undefined, extraHeaders: [string, string][] = []) {
  const sub = (s: string) => interpolate(s, env);
  let url = sub(tab.url.trim());
  const params = tab.params.filter((p) => p.enabled && p.key);
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
