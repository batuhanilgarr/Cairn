import { stringify } from "yaml";
import { applyDefaults } from "./inherit";
import { loadChain, readRequest } from "./collection";
import { listFilesRecursive } from "./fs";
import { isSensitiveName, redactSensitive, scanText } from "./secrets";
import type { KV, RequestTab } from "./types";

/**
 * Collection -> OpenAPI 3.0.3. Requests become operations, folders become tags, saved examples become responses,
 * auth settings become security schemes. Credentials are never written: auth values are left out, and sensitive
 * fields in examples are replaced. The result re-imports into Cairn (see parseOpenApi).
 */
export type ExportItem = { tab: RequestTab; folder: string[]; file: string };
export type ExportOptions = {
  title: string;
  version?: string;
  /** Variable values (collection variables and the chosen environment, secrets excluded) used to resolve {{baseUrl}}. */
  vars?: Record<string, string>;
};
export type ExportResult = { doc: Record<string, any>; notes: string[]; operations: number };

type Obj = Record<string, any>;
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const SKIP_HEADERS = new Set(["content-type", "accept", "authorization", "content-length", "host", "user-agent", "cookie", "connection", "accept-encoding"]);
const REDACTED = "<redacted>";

/* --------------------------------- helpers -------------------------------- */

const isVarRef = (s: string) => /^\{\{[^}]+\}\}$/.test(s.trim());
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase()) || "request";

/** A JSON-schema type for a literal value. */
function inferSchema(v: unknown, depth = 0): Obj {
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: "array", items: v.length && depth < 8 ? inferSchema(v[0], depth + 1) : {} };
  switch (typeof v) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: Number.isInteger(v) ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      if (depth >= 8) return { type: "object" };
      const props: Obj = {};
      for (const [k, x] of Object.entries(v as Obj)) props[k] = inferSchema(x, depth + 1);
      return { type: "object", properties: props };
    }
    default:
      return {};
  }
}

/** An example in the type its schema declares (a "10" example on an integer parameter would be invalid). */
const typed = (value: string, schema: Obj): string | number | boolean => (schema.type === "integer" || schema.type === "number" ? Number(value) : schema.type === "boolean" ? value === "true" : value);

const scalarSchema = (value: string): Obj => (/^-?\d+$/.test(value) ? { type: "integer" } : /^-?\d*\.\d+$/.test(value) ? { type: "number" } : /^(true|false)$/.test(value) ? { type: "boolean" } : { type: "string" });

const redact = (v: unknown) => redactSensitive(v, REDACTED);

/** JSON with unquoted {{variables}} (valid in Cairn, not in JSON) still parses. */
function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(text.replace(/(?<=[:[,]\s*)\{\{[^}]*\}\}(?=\s*[,\]}])/g, (m) => JSON.stringify(m))) };
    } catch {
      return { ok: false };
    }
  }
}

/** Text that holds a credential is dropped from the spec rather than copied into it. */
const leaks = (text: string) => scanText("example", text).length > 0;

const resolveVars = (s: string, vars: Record<string, string>) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, n: string) => (vars[n] !== undefined && vars[n] !== "" ? vars[n] : m));

/** Split a request URL into the server it targets and the path (with {{x}} and :x turned into {x}). */
function splitUrl(raw: string, vars: Record<string, string>): { server: string | null; serverVar: string | null; path: string; query: [string, string][]; pathParams: string[] } {
  let url = raw.trim();
  let server: string | null = null;
  let serverVar: string | null = null;
  const lead = /^\{\{\s*([\w.-]+)\s*\}\}/.exec(url);
  if (lead) {
    const val = vars[lead[1]];
    if (val) {
      server = val.replace(/\/+$/, "");
      url = url.slice(lead[0].length);
    } else {
      serverVar = lead[1];
      server = `{${lead[1]}}`;
      url = url.slice(lead[0].length);
    }
  } else {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(resolveVars(url, vars));
    if (m) {
      server = m[1];
      url = resolveVars(url, vars).slice(m[1].length);
    }
  }
  const q = url.indexOf("?");
  const pathRaw = (q >= 0 ? url.slice(0, q) : url).replace(/#.*$/, "");
  const query: [string, string][] = [];
  if (q >= 0) {
    for (const pair of url.slice(q + 1).replace(/#.*$/, "").split("&").filter(Boolean)) {
      const i = pair.indexOf("=");
      const dec = (x: string) => {
        try {
          return decodeURIComponent(x);
        } catch {
          return x;
        }
      };
      query.push([dec(i < 0 ? pair : pair.slice(0, i)), i < 0 ? "" : dec(pair.slice(i + 1))]);
    }
  }
  const pathParams: string[] = [];
  const path = (pathRaw.startsWith("/") || !pathRaw ? pathRaw : "/" + pathRaw)
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, n: string) => (pathParams.push(n), `{${n}}`))
    .replace(/\/:([A-Za-z_][\w-]*)/g, (_m, n: string) => (pathParams.push(n), `/{${n}}`)) || "/";
  return { server, serverVar, path, query, pathParams };
}

/* ---------------------------------- build --------------------------------- */

export function buildOpenApi(items: ExportItem[], opts: ExportOptions): ExportResult {
  const vars = opts.vars ?? {};
  const notes: string[] = [];
  const paths: Obj = {};
  const tagSet = new Set<string>();
  const servers: Obj[] = [];
  const serverUrls: string[] = [];
  const schemes: Obj = {};
  const usedIds = new Set<string>();
  let operations = 0;

  const addServer = (url: string, serverVar: string | null) => {
    if (serverUrls.includes(url)) return;
    serverUrls.push(url);
    servers.push(serverVar ? { url, description: `Set the ${serverVar} variable of your environment`, variables: { [serverVar]: { default: "https://api.example.com" } } } : { url });
  };

  // A link and the request it points at are one request: export it once (and a request linked from several places once).
  const linkedSeen = new Set<string>();
  for (const { tab, folder } of items) {
    if (tab.linkTo) {
      if (items.some((o) => !o.tab.linkTo && o.file === tab.linkTo) || linkedSeen.has(tab.linkTo)) continue;
      linkedSeen.add(tab.linkTo);
    }
    if (tab.kind !== "http" && tab.kind !== "graphql") {
      notes.push(`Skipped "${tab.name}": ${tab.kind} requests have no OpenAPI form.`);
      continue;
    }
    const method = (tab.kind === "graphql" ? "post" : tab.method.toLowerCase());
    if (!METHODS.has(method)) {
      notes.push(`Skipped "${tab.name}": ${tab.method} isn't an OpenAPI method.`);
      continue;
    }
    const u = splitUrl(tab.url, vars);
    if (!tab.url.trim()) {
      notes.push(`Skipped "${tab.name}": it has no URL.`);
      continue;
    }
    if (u.server) addServer(u.server, u.serverVar);
    const path = u.path || "/";
    paths[path] ??= {};
    if (paths[path][method]) {
      notes.push(`"${tab.name}" shares ${method.toUpperCase()} ${path} with another request; kept the first.`);
      continue;
    }

    const op: Obj = { summary: tab.name };
    const tag = folder.join(" / ");
    if (tag) (op.tags = [tag], tagSet.add(tag));
    let id = slug(tab.name);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(tab.name)}${n}`;
    usedIds.add(id);
    op.operationId = id;
    if (u.server && serverUrls[0] !== u.server) op.servers = [servers[serverUrls.indexOf(u.server)]];

    // parameters: path, query (URL and Params table), headers
    const params: Obj[] = [];
    const seen = new Set<string>();
    const push = (p: Obj) => {
      const k = `${p.in}:${p.name}`;
      if (seen.has(k)) return;
      seen.add(k);
      params.push(p);
    };
    for (const n of new Set(u.pathParams)) push({ name: n, in: "path", required: true, schema: { type: "string" } });
    const queryRows: [string, string][] = [...u.query, ...tab.params.filter((p: KV) => p.enabled && p.key).map((p: KV): [string, string] => [p.key, p.value])];
    for (const [name, value] of queryRows) {
      const secret = isSensitiveName(name);
      const schema = scalarSchema(value);
      const p: Obj = { name, in: "query", schema };
      if (secret) {
        schemes[`apiKey${slug(name)[0].toUpperCase()}${slug(name).slice(1)}Query`] = { type: "apiKey", in: "query", name };
        continue;
      }
      if (value && !value.includes("{{")) p.example = typed(value, schema);
      else if (isVarRef(value)) p.description = `Variable ${value}`;
      push(p);
    }
    const security: Obj[] = [];
    for (const [name, scheme] of Object.entries(schemes)) if (scheme.in === "query" && queryRows.some(([q]) => q === scheme.name)) security.push({ [name]: [] });
    for (const h of tab.headers.filter((x: KV) => x.enabled && x.key)) {
      const lk = h.key.toLowerCase();
      if (SKIP_HEADERS.has(lk)) continue;
      if (isSensitiveName(h.key)) {
        const key = `apiKey${slug(h.key)[0].toUpperCase()}${slug(h.key).slice(1)}`;
        schemes[key] = { type: "apiKey", in: "header", name: h.key };
        security.push({ [key]: [] });
        continue;
      }
      const hs = scalarSchema(h.value);
      push({ name: h.key, in: "header", schema: hs, ...(h.value && !h.value.includes("{{") ? { example: typed(h.value, hs) } : {}) });
    }

    // auth
    switch (tab.authMode) {
      case "bearer":
        schemes.bearerAuth = { type: "http", scheme: "bearer" };
        security.push({ bearerAuth: [] });
        break;
      case "basic":
        schemes.basicAuth = { type: "http", scheme: "basic" };
        security.push({ basicAuth: [] });
        break;
      case "oauth2": {
        const o = tab.oauth;
        const scopes = Object.fromEntries(o.scope.split(/[\s,]+/).filter(Boolean).map((s) => [s, ""]));
        const tokenUrl = resolveVars(o.tokenUrl, vars);
        const flow = o.grant === "client_credentials" ? { clientCredentials: { tokenUrl, scopes } } : o.grant === "password" ? { password: { tokenUrl, scopes } } : { authorizationCode: { authorizationUrl: resolveVars(o.authUrl, vars), tokenUrl, scopes } };
        const name = "oauth2";
        if (!schemes[name]) schemes[name] = { type: "oauth2", flows: flow };
        else if (JSON.stringify(schemes[name].flows) !== JSON.stringify(flow)) notes.push(`"${tab.name}" uses a different OAuth 2.0 setup than the first one; the spec describes only the first.`);
        security.push({ [name]: Object.keys(scopes) });
        break;
      }
    }
    // "none" is an explicit choice in Cairn: say so, instead of leaving the operation looking undecided
    if (security.length) op.security = security;
    else if (tab.authMode === "none") op.security = [];
    if (params.length) op.parameters = params;

    // request body
    if (tab.kind === "graphql") {
      let variables: unknown = {};
      try {
        variables = tab.gql.variables.trim() ? JSON.parse(tab.gql.variables) : {};
      } catch {
        /* keep {} */
      }
      const example = { query: tab.gql.query, variables: redact(variables), ...(tab.gql.operation.trim() ? { operationName: tab.gql.operation.trim() } : {}) };
      op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, variables: { type: "object" }, operationName: { type: "string" } }, required: ["query"] }, example } } };
    } else if (tab.bodyMode !== "none" && !["get", "head"].includes(method)) {
      const content: Obj = {};
      if (tab.bodyMode === "json") {
        const r = parseJsonLoose(tab.body);
        if (r.ok) {
          const ex = redact(r.value);
          content["application/json"] = { schema: inferSchema(ex), example: ex };
        } else {
          content["application/json"] = { schema: {} };
          notes.push(`"${tab.name}": the JSON body has a syntax error, so no example was written for it.`);
        }
      } else if (tab.bodyMode === "form") {
        const props: Obj = {};
        for (const pair of tab.body.split("&").filter(Boolean)) {
          const i = pair.indexOf("=");
          const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
          props[k] = scalarSchema(i < 0 ? "" : decodeURIComponent(pair.slice(i + 1)));
        }
        content["application/x-www-form-urlencoded"] = { schema: { type: "object", properties: props } };
      } else if (tab.bodyMode === "multipart") {
        const props: Obj = {};
        for (const p of tab.formParts.filter((x) => x.enabled && x.key)) props[p.key] = p.kind === "file" ? { type: "string", format: "binary" } : { type: "string" };
        content["multipart/form-data"] = { schema: { type: "object", properties: props } };
      } else if (tab.bodyMode === "binary") {
        content["application/octet-stream"] = { schema: { type: "string", format: "binary" } };
      } else {
        const safe = !leaks(tab.body);
        content["text/plain"] = { schema: { type: "string" }, ...(safe && tab.body ? { example: tab.body } : {}) };
        if (!safe) notes.push(`"${tab.name}": the body holds a credential, so no example was written for it.`);
      }
      op.requestBody = { content };
    }

    // responses: saved examples, else the status the request's tests expect
    const responses: Obj = {};
    for (const ex of tab.examples) {
      const code = String(ex.status);
      if (responses[code]) continue;
      const ct = (ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "").split(";")[0].trim();
      const parsed = parseJsonLoose(ex.body);
      const r: Obj = { description: ex.name || `Status ${code}` };
      if (ex.body) {
        if (parsed.ok && (ct.includes("json") || !ct)) {
          const v = redact(parsed.value);
          r.content = { [ct || "application/json"]: { schema: inferSchema(v), example: v } };
        } else if (leaks(ex.body)) {
          r.content = { [ct || "text/plain"]: { schema: { type: "string" } } };
          notes.push(`"${tab.name}": the ${code} example holds a credential, so it was left out.`);
        } else r.content = { [ct || "text/plain"]: { schema: { type: "string" }, example: ex.body } };
      }
      responses[code] = r;
    }
    if (!Object.keys(responses).length) {
      for (const a of tab.assertions) if (a.enabled && a.kind === "status" && a.op === "eq" && /^\d{3}$/.test(a.value.trim())) responses[a.value.trim()] = { description: "Expected by this request's tests" };
    }
    op.responses = Object.keys(responses).length ? responses : { default: { description: "Response" } };

    paths[path][method] = op;
    operations++;
  }

  const doc: Obj = {
    openapi: "3.0.3",
    info: { title: opts.title || "API", version: opts.version ?? "1.0.0", description: "Generated by Cairn from a collection of requests. Credentials are not included." },
  };
  if (servers.length) doc.servers = servers;
  if (tagSet.size) doc.tags = [...tagSet].sort().map((name) => ({ name, description: `Requests in the “${name}” folder.` }));
  doc.paths = paths;
  if (Object.keys(schemes).length) doc.components = { securitySchemes: schemes };
  return { doc, notes, operations };
}

export const toYaml = (doc: Obj) => stringify(doc, { lineWidth: 0 });
export const toJson = (doc: Obj) => JSON.stringify(doc, null, 2) + "\n";

/** Read every request of a collection with its folder defaults applied (inherited auth and headers included). */
export async function collectExportItems(root: string, rootLabel: string): Promise<{ items: ExportItem[]; unreadable: string[] }> {
  const files = (await listFilesRecursive(root, ".req.yaml")).sort();
  const items: ExportItem[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    try {
      const tab = await readRequest(file);
      const chain = await loadChain(root, file, rootLabel);
      const eff = applyDefaults(tab, chain.map((c) => ({ label: c.label, defaults: c.defaults })));
      const rel = file.slice(root.length + 1).split("/");
      items.push({ tab: eff.tab, folder: rel.slice(0, -1), file });
    } catch {
      unreadable.push(file);
    }
  }
  return { items, unreadable };
}
