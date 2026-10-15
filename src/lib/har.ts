import { serializeRequest } from "./collection";
import type { ImportResult, ImportedRequest } from "./openapi";
import { isSensitiveName, redactSensitive, scanText, suggestVarName } from "./secrets";
import type { KV, RequestTab, ResponseExample } from "./types";
import { emptyKV, emptyPart, newTab, uid } from "./util";

/**
 * HAR (HTTP Archive, "Save all as HAR" in a browser's Network tab) -> Cairn requests.
 * A recording holds real sessions, so nothing sensitive is written to the files: Authorization, API keys, passwords,
 * cookies and tokens are moved into secret variables (returned in `secrets`, for the caller to store off-disk-in-Git)
 * or dropped. Cairn's own secret scanner finds nothing in what this produces (tested).
 */

type Obj = Record<string, any>;
export type HarOptions = {
  /** Keep pages, scripts, styles, images and fonts too. Default: API calls only. */
  includeStatic?: boolean;
};

export function isHar(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text)?.log?.entries);
  } catch {
    return false;
  }
}

const DROP_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding", "accept-language", "user-agent", "referer", "origin", "cookie", "upgrade-insecure-requests",
  "dnt", "pragma", "cache-control", "if-none-match", "if-modified-since", "priority", "te", "keep-alive", "proxy-connection", "x-client-data",
]);
const SKIP_TYPES = new Set(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "manifest", "websocket", "ping", "preflight", "prefetch", "cspviolationreport", "signedexchange", "eventsource"]);
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/(css|html|javascript)|javascript|^application\/(font|wasm|x-font)/i;
const MAX_EXAMPLE = 200_000;

const kvOf = (key: string, value: string): KV => ({ ...emptyKV(), key, value });
const lower = (s: unknown) => String(s ?? "").toLowerCase();
/** base64 -> UTF-8 text, in the browser and in Node (no Buffer). */
function b64ToText(b64: string): string {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}

function decodeContent(c: Obj | undefined): string | null {
  if (!c || typeof c.text !== "string") return null;
  if (c.encoding === "base64") {
    try {
      return b64ToText(c.text);
    } catch {
      return null;
    }
  }
  return c.text;
}

export function parseHar(text: string, title: string, opts: HarOptions = {}): ImportResult {
  const log = JSON.parse(text)?.log;
  if (!Array.isArray(log?.entries)) throw new Error("This isn't a HAR file (no log.entries).");
  const notes: string[] = [];
  const secrets: Record<string, string> = {};
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  /** Move a value out of the files: returns {{name}} and remembers the value. */
  const protect = (hint: string, value: string): string => {
    if (!value || value.includes("{{")) return value;
    const existing = Object.entries(secrets).find(([, v]) => v === value);
    if (existing) return `{{${existing[0]}}}`;
    const stem = suggestVarName(hint, "har") || "secret";
    let name = stem;
    for (let i = 2; name in secrets; i++) name = `${stem}${i}`;
    secrets[name] = value;
    return `{{${name}}}`;
  };

  const entries: Obj[] = [...log.entries].sort((a, b) => String(a.startedDateTime ?? "").localeCompare(String(b.startedDateTime ?? "")));

  // 1. which entries are API calls
  const kept: Obj[] = [];
  for (const e of entries) {
    const req = e.request ?? {};
    const url = String(req.url ?? "");
    const method = String(req.method ?? "GET").toUpperCase();
    if (!/^https?:\/\//i.test(url)) {
      skip("non-http");
      continue;
    }
    if (!opts.includeStatic) {
      if (method === "OPTIONS") {
        skip("preflight");
        continue;
      }
      const type = lower(e._resourceType);
      const mime = lower(e.response?.content?.mimeType).split(";")[0];
      if (type && SKIP_TYPES.has(type) && !(type === "document" && /json|xml/.test(mime))) {
        skip("page, script, style, image or font");
        continue;
      }
      if (!type && STATIC_MIME.test(mime)) {
        skip("page, script, style, image or font");
        continue;
      }
    }
    kept.push(e);
  }

  // 2. the most common origin becomes {{baseUrl}}
  const counts = new Map<string, number>();
  for (const e of kept) {
    const o = originOf(String(e.request.url));
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const base = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const multiOrigin = counts.size > 1;

  const requests: ImportedRequest[] = [];
  const seen = new Set<string>();
  let repeats = 0;
  let cookiesDropped = 0;
  const fileParts: string[] = [];

  for (const e of kept) {
    const req = e.request;
    let url = String(req.url);
    const method = String(req.method ?? "GET").toUpperCase();
    const tab: RequestTab = { ...newTab(), id: uid(), method, headers: [] };

    // credentials in the URL: user:pass@ and sensitive query parameters
    url = url.replace(/^(https?:\/\/)([^/:@]+):([^@/]*)@/i, (_m, scheme: string, user: string, pass: string) => `${scheme}${user}:${protect("url password", decodeURIComponent(pass))}@`);
    url = url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep: string, name: string, value: string) => {
      const n = decodeURIComponent(name);
      return isSensitiveName(n) && value ? `${sep}${name}=${protect(n, decodeURIComponent(value))}` : m;
    });

    // headers
    for (const h of (req.headers ?? []) as Obj[]) {
      const name = String(h.name ?? "");
      const lk = name.toLowerCase();
      const value = String(h.value ?? "");
      if (!name || lk.startsWith(":") || lk.startsWith("sec-") || DROP_HEADERS.has(lk)) {
        if (lk === "cookie" && value) cookiesDropped++;
        continue;
      }
      if (lk === "authorization") {
        const m = /^(\S+)\s+(.+)$/.exec(value);
        if (m && /^bearer$/i.test(m[1])) {
          tab.authMode = "bearer";
          tab.authToken = protect("token", m[2]);
        } else if (m && /^basic$/i.test(m[1])) {
          let decoded = "";
          try {
            decoded = b64ToText(m[2]);
          } catch {
            /* not valid base64: kept as a protected header below */
          }
          const i = decoded.indexOf(":");
          if (i > 0) {
            tab.authMode = "basic";
            tab.authUser = decoded.slice(0, i);
            tab.authPass = protect("password", decoded.slice(i + 1));
          } else tab.headers.push(kvOf(name, protect("authorization", value)));
        } else tab.headers.push(kvOf(name, protect("authorization", value)));
        continue;
      }
      if (isSensitiveName(name)) {
        tab.headers.push(kvOf(name, protect(name, value)));
        continue;
      }
      if (lk === "accept" && value === "*/*") continue;
      tab.headers.push(kvOf(name, value));
    }

    // body
    const post = req.postData as Obj | undefined;
    const mime = lower(post?.mimeType).split(";")[0].trim();
    const ptext = typeof post?.text === "string" ? post.text : "";
    const params: Obj[] = Array.isArray(post?.params) ? post.params : [];
    const dropContentType = () => (tab.headers = tab.headers.filter((h) => lower(h.key) !== "content-type"));
    if (post && (ptext || params.length) && !["GET", "HEAD"].includes(method)) {
      if (mime.includes("json") || (!mime && /^\s*[[{]/.test(ptext))) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ptext);
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Obj).query === "string" && /graphql/i.test(url)) {
          const g = parsed as Obj;
          tab.kind = "graphql";
          tab.method = "POST";
          tab.gql = {
            query: g.query,
            variables: g.variables && Object.keys(g.variables).length ? JSON.stringify(redactSensitive(g.variables, (k, v) => protect(k, v)), null, 2) : "",
            operation: typeof g.operationName === "string" ? g.operationName : "",
          };
          dropContentType();
        } else if (parsed !== undefined) {
          tab.bodyMode = "json";
          tab.body = JSON.stringify(redactSensitive(parsed, (k, v) => protect(k, v)), null, 2);
          dropContentType();
        } else {
          tab.bodyMode = "text";
          tab.body = ptext;
        }
      } else if (mime === "application/x-www-form-urlencoded") {
        const pairs = params.length ? params.map((p) => [String(p.name), String(p.value ?? "")]) : ptext.split("&").filter(Boolean).map((x) => { const i = x.indexOf("="); const d = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } }; return [d(i < 0 ? x : x.slice(0, i)), i < 0 ? "" : d(x.slice(i + 1))]; });
        tab.bodyMode = "form";
        tab.body = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${isSensitiveName(k) && v ? encodeURIComponent(protect(k, v)).replace(/%7B/g, "{").replace(/%7D/g, "}") : encodeURIComponent(v)}`).join("&");
        dropContentType();
      } else if (mime === "multipart/form-data" && params.length) {
        tab.bodyMode = "multipart";
        tab.formParts = params.map((p) => {
          const isFile = !!p.fileName;
          if (isFile) fileParts.push(String(p.fileName));
          const value = isFile ? "" : String(p.value ?? "");
          return { ...emptyPart(), key: String(p.name ?? ""), value: !isFile && isSensitiveName(String(p.name)) && value ? protect(String(p.name), value) : value, kind: isFile ? "file" : "text", ...(p.contentType ? { contentType: String(p.contentType) } : {}) };
        });
        dropContentType();
      } else {
        tab.bodyMode = "text";
        tab.body = ptext;
        if (mime && mime !== "text/plain") tab.headers.push(kvOf("Content-Type", String(post.mimeType)));
        else dropContentType();
      }
    }

    // example from the recorded response
    const res = e.response ?? {};
    const rtext = decodeContent(res.content);
    if (rtext && rtext.length <= MAX_EXAMPLE && Number(res.status) > 0) {
      const rmime = String(res.content?.mimeType ?? "");
      const textual = /json|xml|text|html|javascript|yaml|csv|x-www-form/i.test(rmime) || !rmime;
      if (textual) {
        let body = rtext;
        const j = tryParse(rtext);
        if (j !== undefined) body = JSON.stringify(redactSensitive(j, "<redacted>"), null, 2);
        const leaks = scanText("example", `body: ${body.replace(/\n/g, " ")}\n`).length > 0 && j === undefined;
        if (!leaks) {
          const ex: ResponseExample = { id: uid(), name: `Recorded ${res.status}`, status: Number(res.status), headers: rmime ? [kvOf("Content-Type", rmime)] : [], body, delayMs: 0 };
          tab.examples = [ex];
        } else notes.push(`${method} ${new URL(url).pathname}: the recorded response holds a credential, so it was not kept as an example.`);
      }
    }

    // base URL as a variable
    const origin = originOf(url);
    if (origin && origin === base) url = "{{baseUrl}}" + url.slice(origin.length);
    tab.url = url;
    let path = "/";
    try {
      path = new URL(String(req.url)).pathname || "/";
    } catch {
      /* keep "/" */
    }
    tab.name = `${tab.method} ${path.length > 60 ? "…" + path.slice(-57) : path}`;

    // anything the scanner still finds is moved out of the files too (a token in a text body, say)
    for (let pass = 0; pass < 3; pass++) {
      const found = scanText("har", serializeRequest(tab)).filter((f) => f.fixable && f.end - f.start >= 6);
      if (!found.length) break;
      const text = serializeRequest(tab).split("\n");
      for (const f of found) {
        const value = text[f.line - 1]?.slice(f.start, f.end);
        if (!value) continue;
        const ref = protect(f.suggest || "secret", value);
        const swap = (s: string) => s.split(value).join(ref);
        tab.url = swap(tab.url);
        tab.body = swap(tab.body);
        tab.headers = tab.headers.map((h) => ({ ...h, value: swap(h.value) }));
        tab.formParts = tab.formParts.map((p) => ({ ...p, value: swap(p.value) }));
        tab.gql = { ...tab.gql, query: swap(tab.gql.query), variables: swap(tab.gql.variables) };
        tab.authToken = swap(tab.authToken);
        tab.authPass = swap(tab.authPass);
        for (const ex of tab.examples) ex.body = swap(ex.body);
      }
    }
    tab.headers = [...tab.headers, emptyKV()];

    const key = [tab.method, tab.url, tab.body, tab.gql.query, tab.formParts.map((p) => p.key + p.value).join("&")].join("\u0000");
    if (seen.has(key)) {
      repeats++;
      continue;
    }
    seen.add(key);
    let host = "";
    try {
      host = new URL(String(req.url)).hostname;
    } catch {
      /* none */
    }
    requests.push({ folder: multiOrigin && host ? [host] : [], base: tab.name, tab });
  }

  for (const [why, n] of Object.entries(skipped)) notes.push(`Skipped ${n} ${why} request${n === 1 ? "" : "s"} (not API calls). Import again with “everything” to keep them.`);
  if (repeats) notes.push(`${repeats} repeated request${repeats === 1 ? "" : "s"} (same method, URL and body) kept once.`);
  if (cookiesDropped) notes.push(`Cookie headers were dropped (${cookiesDropped}): they're session credentials. Cairn keeps cookies from responses in its own jar.`);
  if (fileParts.length) notes.push(`Uploaded files aren't in a HAR: choose the file again for ${[...new Set(fileParts)].slice(0, 4).join(", ")}${new Set(fileParts).size > 4 ? "…" : ""}.`);
  if (Object.keys(secrets).length) notes.push(`${Object.keys(secrets).length} credential${Object.keys(secrets).length === 1 ? "" : "s"} (tokens, passwords, keys) moved into secret variables, not into the files.`);

  return { title, vars: base ? { baseUrl: base } : {}, secrets, requests, notes };
}

function tryParse(s: string): unknown {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}
