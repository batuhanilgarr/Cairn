import type { AuthMode, BodyMode, FormPart, KV, OAuthConfig, RequestTab, ResponseExample } from "./types";
import { defaultOAuth, emptyKV, emptyPart, newTab, tryPrettyJson, uid } from "./util";
import { DYNAMIC_VARS } from "./dynamic";
import type { ImportResult, ImportedFolder, ImportedRequest } from "./openapi";

type Obj = Record<string, any>;

export type PostmanKind = "collection" | "environment" | "globals" | "unknown";

/** What a Postman export file is: a collection, an environment or the globals. */
export function detectPostman(text: string): PostmanKind {
  let j: Obj;
  try {
    j = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const col = j?.collection ?? j; // the Postman API wraps a collection in { collection }
  if (col?.info && Array.isArray(col.item)) return "collection";
  if (Array.isArray(j?.values)) return j._postman_variable_scope === "globals" ? "globals" : "environment";
  return "unknown";
}

const rows = (list: any): KV[] => [
  ...(Array.isArray(list) ? list : [])
    .filter((r: Obj) => r?.key)
    .map((r: Obj) => ({ ...emptyKV(), key: String(r.key), value: String(r.value ?? ""), enabled: !r.disabled })),
  emptyKV(),
];

/** Postman v2.1 stores auth as [{key,value}] lists; v2.0 as a plain object. */
const authField = (a: any, key: string): string => {
  if (Array.isArray(a)) return String(a.find((x: Obj) => x.key === key)?.value ?? "");
  return String(a?.[key] ?? "");
};

type AuthOut = { fields: Partial<RequestTab>; header?: [string, string]; param?: [string, string] };

type Protect = (value: string, hint: string) => string;

function convertAuth(a: Obj | undefined, label: string, notes: string[], protect: Protect): AuthOut | null {
  if (!a) return null; // not set here: inherits
  switch (a.type) {
    case "noauth":
      return { fields: { authMode: "none" } };
    case "bearer":
      return { fields: { authMode: "bearer", authToken: protect(authField(a.bearer, "token"), `${label} token`) } };
    case "basic":
      return { fields: { authMode: "basic", authUser: authField(a.basic, "username"), authPass: protect(authField(a.basic, "password"), `${label} password`) } };
    case "apikey": {
      const key = authField(a.apikey, "key");
      const value = protect(authField(a.apikey, "value"), `${label} api key`);
      return authField(a.apikey, "in") === "query" ? { fields: { authMode: "none" }, param: [key, value] } : { fields: { authMode: "none" }, header: [key, value] };
    }
    case "oauth2": {
      const g = (k: string) => authField(a.oauth2, k);
      if (!g("accessTokenUrl") && g("accessToken")) return { fields: { authMode: "bearer", authToken: protect(g("accessToken"), `${label} access token`) } };
      const raw = g("grant_type");
      const grant: OAuthConfig["grant"] = raw.includes("client_credentials") ? "client_credentials" : raw.includes("password") ? "password" : "authorization_code";
      const redirect = g("redirect_uri");
      const port = redirect.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/)?.[1];
      if (grant === "authorization_code" && redirect && !port) notes.push(`"${label}": OAuth redirect ${redirect} was replaced by Reqnest's local callback (127.0.0.1:<port>/callback); register that URL with your provider`);
      const extra: KV[] = [];
      for (const k of ["audience", "resource"]) if (g(k)) extra.push({ ...emptyKV(), key: k, value: g(k) });
      const oauth: OAuthConfig = {
        ...defaultOAuth(),
        grant,
        authUrl: g("authUrl"),
        tokenUrl: g("accessTokenUrl"),
        clientId: g("clientId"),
        clientSecret: protect(g("clientSecret"), `${label} client secret`),
        scope: g("scope"),
        username: g("username"),
        password: protect(g("password"), `${label} password`),
        pkce: raw.includes("pkce") || g("challengeAlgorithm") !== "",
        clientAuth: g("client_authentication") === "body" ? "body" : "basic",
        prefix: g("headerPrefix") || "Bearer",
        extra: [...extra, emptyKV()],
        ...(port ? { redirectPort: Number(port) } : {}),
      };
      return { fields: { authMode: "oauth2", oauth } };
    }
    default:
      notes.push(`"${label}": ${a.type} auth isn't supported yet, imported without auth`);
      return { fields: { authMode: "none" } };
  }
}

const UNSUPPORTED_SCRIPT = [/pm\.sendRequest/, /\brequire\s*\(/, /CryptoJS/, /\bxml2Json\b/, /\bcheerio\b/, /postman\.setNextRequest/, /pm\.cookies/, /pm\.visualizer/];

function scriptsOf(events: any, label: string, notes: string[]): { pre: string; post: string } {
  const out = { pre: "", post: "" };
  for (const e of Array.isArray(events) ? events : []) {
    const exec = e?.script?.exec;
    const code = Array.isArray(exec) ? exec.join("\n") : String(exec ?? "");
    if (!code.trim()) continue;
    if (e.listen === "prerequest") out.pre += (out.pre ? "\n" : "") + code;
    else if (e.listen === "test") out.post += (out.post ? "\n" : "") + code;
    const bad = UNSUPPORTED_SCRIPT.find((re) => re.test(code));
    if (bad) notes.push(`"${label}": the script uses ${bad.source.replace(/\\b|\\s\*|\\\(|\\/g, "")}, which isn't available in Reqnest scripts`);
  }
  return out;
}

/** Variables, auth, headers and scripts Postman lets you set on the collection or a folder. */
function defaultsOf(src: Obj, label: string, notes: string[], protect: Protect): RequestTab | null {
  const t = newTab();
  t.name = "defaults";
  const vars = (Array.isArray(src.variable) ? src.variable : []).filter((v: Obj) => v?.key && !v.disabled);
  t.vars = [...vars.map((v: Obj) => ({ ...emptyKV(), key: String(v.key), value: String(v.value ?? "") })), emptyKV()];
  const auth = convertAuth(src.auth, label, notes, protect);
  if (auth) {
    Object.assign(t, auth.fields);
    if (auth.header) t.headers = [{ ...emptyKV(), key: auth.header[0], value: auth.header[1] }, emptyKV()];
    if (auth.param) notes.push(`"${label}": an API key sent as a query parameter can't be set for a whole folder, add it to the requests that need it`);
  }
  const s = scriptsOf(src.event, label, notes);
  t.preScript = s.pre;
  t.postScript = s.post;
  const has = vars.length || auth || s.pre || s.post;
  return has ? t : null;
}

const CONTENT_TYPE_FOR: Record<string, string> = { xml: "application/xml", html: "text/html", javascript: "application/javascript" };

function urlOf(u: any): { raw: string; query: Obj[] } {
  if (typeof u === "string") return { raw: u, query: [] };
  const query: Obj[] = Array.isArray(u?.query) ? u.query : [];
  let raw = typeof u?.raw === "string" ? u.raw : "";
  if (!raw && u) {
    const host = Array.isArray(u.host) ? u.host.join(".") : String(u.host ?? "");
    const path = Array.isArray(u.path) ? u.path.join("/") : String(u.path ?? "");
    const qs = query.filter((q) => !q.disabled && q.key).map((q) => `${q.key}=${q.value ?? ""}`).join("&");
    raw = `${u.protocol ? u.protocol + "://" : ""}${host}${u.port ? ":" + u.port : ""}${path ? "/" + path : ""}${qs ? "?" + qs : ""}`;
  }
  // path variables (/users/:id) become their value, or {{id}} when Postman has none
  for (const v of Array.isArray(u?.variable) ? u.variable : []) {
    if (!v?.key) continue;
    const name = String(v.key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    raw = raw.replace(new RegExp(`/:${name}(?=[/?#]|$)`), `/${v.value ? String(v.value) : `{{${v.key}}}`}`);
  }
  return { raw, query };
}

/** Postman Collection v2.0 / v2.1. Each collection lands in its own folder (named after it) with its settings as that folder's defaults. */
export function parsePostman(text: string, prefix?: string[]): ImportResult {
  const root: Obj = JSON.parse(text);
  const col: Obj = root?.collection ?? root;
  if (!col?.info || !Array.isArray(col.item)) throw new Error("This doesn't look like a Postman collection (v2.x JSON).");
  const title = String(col.info.name ?? "Postman import");
  const base = prefix ?? [title];
  const notes: string[] = [];
  const requests: ImportedRequest[] = [];
  const folders: ImportedFolder[] = [];
  const unknownDynamic = new Set<string>();
  // Literal credentials move out of the files into variables, so they never end up in Git.
  const secrets: Record<string, string> = {};
  const protect: Protect = (value, hint) => {
    if (!value || value.includes("{{")) return value;
    const existing = Object.entries(secrets).find(([, v]) => v === value);
    if (existing) return `{{${existing[0]}}}`;
    const stem = (hint.toLowerCase().startsWith(title.toLowerCase()) ? hint : `${title} ${hint}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    let name = stem;
    for (let i = 2; name in secrets; i++) name = `${stem}_${i}`;
    secrets[name] = value;
    return `{{${name}}}`;
  };

  const scanDynamic = (s: string) => {
    for (const m of s.matchAll(/\{\{\s*(\$[\w]+)\s*\}\}/g)) if (!(m[1] in DYNAMIC_VARS)) unknownDynamic.add(m[1]);
  };

  const rootDefaults = defaultsOf(col, title, notes, protect);
  if (rootDefaults) folders.push({ path: base, defaults: rootDefaults });

  const walk = (items: Obj[], folder: string[]) => {
    for (const it of items) {
      if (Array.isArray(it.item)) {
        const path = [...folder, String(it.name ?? "folder")];
        const d = defaultsOf(it, path.slice(base.length).join(" / ") || title, notes, protect);
        if (d) folders.push({ path, defaults: d });
        walk(it.item, path);
        continue;
      }
      const r: Obj = it.request ?? {};
      const t = newTab();
      t.name = String(it.name ?? "Request");
      t.method = String(r.method ?? "GET").toUpperCase();
      const url = urlOf(r.url);
      t.url = url.raw;
      t.params = [...url.query.filter((q) => q.disabled && q.key).map((q) => ({ ...emptyKV(), key: String(q.key), value: String(q.value ?? ""), enabled: false })), emptyKV()];
      t.headers = rows(r.header);
      if (it.protocolProfileBehavior?.followRedirects === false) t.followRedirects = false;

      const b: Obj | undefined = r.body;
      let mode: BodyMode = "none";
      if (b?.mode === "raw") {
        const lang = b.options?.raw?.language;
        const raw = String(b.raw ?? "");
        const isJson = lang === "json" || (!lang && tryPrettyJson(raw) !== null);
        mode = isJson ? "json" : "text";
        t.body = raw;
        const ct = CONTENT_TYPE_FOR[lang as string];
        if (ct && !t.headers.some((h) => h.key.toLowerCase() === "content-type")) t.headers = [{ ...emptyKV(), key: "Content-Type", value: ct }, ...t.headers];
      } else if (b?.mode === "urlencoded") {
        mode = "form";
        t.body = (b.urlencoded ?? [])
          .filter((x: Obj) => !x.disabled)
          .map((x: Obj) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? "")}`)
          .join("&");
      } else if (b?.mode === "formdata") {
        mode = "multipart";
        const parts: FormPart[] = (b.formdata ?? [])
          .filter((x: Obj) => x?.key)
          .map((x: Obj): FormPart => {
            const file = x.type === "file";
            const src = Array.isArray(x.src) ? x.src[0] : x.src;
            return { ...emptyPart(), key: String(x.key), kind: file ? "file" : "text", value: String((file ? src : x.value) ?? ""), enabled: !x.disabled, ...(x.contentType ? { contentType: String(x.contentType) } : {}) };
          });
        t.formParts = [...parts, emptyPart()];
        if (parts.some((p) => p.kind === "file")) notes.push(`"${t.name}": file fields keep the path from the Postman export, choose the files again if they aren't on this Mac`);
      } else if (b?.mode === "file") {
        mode = "binary";
        t.body = String((Array.isArray(b.file?.src) ? b.file.src[0] : b.file?.src) ?? "");
      } else if (b?.mode === "graphql") {
        t.kind = "graphql";
        t.method = "POST";
        t.gql = { query: String(b.graphql?.query ?? ""), variables: String(b.graphql?.variables ?? ""), operation: "" };
      }
      t.bodyMode = mode;

      const auth = convertAuth(r.auth, `${base.length > 1 ? base[0] + " " : ""}${t.name}`, notes, protect);
      if (auth) {
        Object.assign(t, auth.fields);
        if (auth.header && auth.header[0]) t.headers = [{ ...emptyKV(), key: auth.header[0], value: auth.header[1] }, ...t.headers];
        if (auth.param && auth.param[0]) t.params = [{ ...emptyKV(), key: auth.param[0], value: auth.param[1] }, ...t.params];
      } else t.authMode = "inherit" as AuthMode;

      const s = scriptsOf(it.event, t.name, notes);
      t.preScript = s.pre;
      t.postScript = s.post;

      t.examples = (Array.isArray(it.response) ? it.response : []).map(
        (e: Obj): ResponseExample => ({
          id: uid(),
          name: String(e.name ?? "Example"),
          status: Number(e.code ?? 200),
          headers: rows(e.header),
          body: String(e.body ?? ""),
          delayMs: 0,
        }),
      );

      scanDynamic([t.url, t.body, ...t.headers.flatMap((h) => [h.key, h.value])].join("\n"));
      requests.push({ folder, base: t.name, tab: t });
    }
  };
  walk(col.item, base);

  if (unknownDynamic.size) notes.push(`Postman dynamic variables Reqnest doesn't generate yet are left as-is: ${[...unknownDynamic].join(", ")}`);
  return { title, vars: {}, folders, secrets, requests, notes: [...new Set(notes)] };
}

export type PostmanEnvironment = {
  name: string;
  scope: "environment" | "globals";
  vars: { key: string; value: string; secret: boolean }[];
  /** Variables that were switched off in Postman, not imported. */
  skipped: number;
};

/** A Postman environment or globals export. Variables of type "secret" stay secret (kept out of Git). */
export function parsePostmanEnvironment(text: string): PostmanEnvironment {
  const j: Obj = JSON.parse(text);
  if (!Array.isArray(j?.values)) throw new Error("This doesn't look like a Postman environment export.");
  const live = j.values.filter((v: Obj) => v?.key && v.enabled !== false);
  return {
    name: String(j.name ?? "Postman environment"),
    scope: j._postman_variable_scope === "globals" ? "globals" : "environment",
    vars: live.map((v: Obj) => ({ key: String(v.key), value: String(v.value ?? ""), secret: v.type === "secret" })),
    skipped: j.values.filter((v: Obj) => v?.key && v.enabled === false).length,
  };
}
