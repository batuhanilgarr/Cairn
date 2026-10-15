import { parse } from "yaml";
import type { AuthMode, BodyMode, KV, RequestTab, ResponseExample } from "./types";
import { defaultOAuth, emptyKV, newTab, tryPrettyJson, uid } from "./util";
import { isWsdl, parseWsdlSync } from "./wsdl";

export type ImportedRequest = {
  /** Folder segments under the collection root (derived from tags). */
  folder: string[];
  /** Preferred file base name (slugged by the writer). */
  base: string;
  tab: RequestTab;
};

/** Defaults (variables, auth, headers, scripts) for a folder of the import: written as that folder's folder.yaml. */
export type ImportedFolder = { path: string[]; defaults: RequestTab };

export type ImportResult = {
  title: string;
  /** Folder-level settings the source format carries (Postman folders and collection root). */
  folders?: ImportedFolder[];
  /** Literal credentials taken out of auth settings and replaced by {{name}}: kept out of the files (and Git). */
  secrets?: Record<string, string>;
  /** Variables the requests reference, with a suggested default (only baseUrl is non-empty). */
  vars: Record<string, string>;
  requests: ImportedRequest[];
  notes: string[];
};

type Obj = Record<string, any>;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function resolveRef(spec: Obj, ref: string): Obj {
  if (!ref.startsWith("#/")) return {};
  return ref
    .slice(2)
    .split("/")
    .reduce((o: any, k) => o?.[decodeURIComponent(k.replace(/~1/g, "/").replace(/~0/g, "~"))], spec) ?? {};
}

/** Follow $ref chains (bounded, to survive cyclic specs). */
function deref(spec: Obj, node: any, depth = 0): any {
  let cur = node;
  for (let i = 0; i < 8 && cur && typeof cur === "object" && cur.$ref; i++) cur = resolveRef(spec, cur.$ref);
  return depth > 20 ? {} : cur;
}

export function sampleFromSchema(spec: Obj, schema: any, depth = 0, seen: string[] = []): any {
  if (!schema || depth > 6) return null;
  if (schema.$ref) {
    if (seen.includes(schema.$ref)) return null; // cycle
    return sampleFromSchema(spec, deref(spec, schema), depth + 1, [...seen, schema.$ref]);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) {
    return schema.allOf.reduce((acc: any, s: any) => {
      const v = sampleFromSchema(spec, s, depth + 1, seen);
      return v && typeof v === "object" && !Array.isArray(v) ? { ...acc, ...v } : acc;
    }, {});
  }
  const alt = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alt) return sampleFromSchema(spec, alt, depth + 1, seen);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const out: Obj = {};
    for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
      if (v?.readOnly) continue;
      out[k] = sampleFromSchema(spec, v, depth + 1, seen);
    }
    return out;
  }
  if (type === "array") return [sampleFromSchema(spec, schema.items, depth + 1, seen)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  switch (schema.format) {
    case "date-time": return "2024-01-01T00:00:00Z";
    case "date": return "2024-01-01";
    case "email": return "user@example.com";
    case "uuid": return "00000000-0000-0000-0000-000000000000";
    case "uri": return "https://example.com";
  }
  return "string";
}

function baseUrlOf(spec: Obj): string {
  if (spec.servers?.[0]?.url) {
    let u: string = spec.servers[0].url;
    for (const [k, v] of Object.entries<any>(spec.servers[0].variables ?? {})) u = u.replace(`{${k}}`, String(v?.default ?? ""));
    return u.replace(/\/$/, "");
  }
  if (spec.host) return `${(spec.schemes ?? ["https"])[0]}://${spec.host}${spec.basePath ?? ""}`.replace(/\/$/, "");
  return "";
}

/** One example per documented response: the spec's own example if it has one, otherwise a sample built from the schema. */
function examplesFrom(spec: Obj, op: Obj, isV2: boolean): ResponseExample[] {
  const out: ResponseExample[] = [];
  const codes = Object.keys(op.responses ?? {}).sort((a, b) => (a.startsWith("2") ? 0 : 1) - (b.startsWith("2") ? 0 : 1) || a.localeCompare(b));
  for (const code of codes) {
    const resp = deref(spec, op.responses[code]) ?? {};
    let sample: unknown;
    if (isV2) {
      sample = resp.examples?.["application/json"] ?? (resp.schema ? sampleFromSchema(spec, resp.schema) : undefined);
    } else if (resp.content) {
      const media = resp.content["application/json"] ?? Object.entries<any>(resp.content).find(([k]) => k.includes("json"))?.[1];
      if (media) sample = media.example ?? Object.values<any>(media.examples ?? {})[0]?.value ?? (media.schema ? sampleFromSchema(spec, media.schema) : undefined);
    }
    const body = sample === undefined || sample === null ? "" : typeof sample === "string" ? sample : JSON.stringify(sample, null, 2);
    out.push({
      id: uid(),
      name: `${code}${resp.description ? ` ${String(resp.description).split("\n")[0]}` : ""}`.slice(0, 60),
      status: /^\d{3}$/.test(code) ? Number(code) : 200,
      headers: body ? [{ ...emptyKV(), key: "Content-Type", value: "application/json" }, emptyKV()] : [emptyKV()],
      body,
      delayMs: 0,
    });
  }
  return out;
}

export function parseOpenApi(text: string): ImportResult {
  const spec: Obj = parse(text);
  if (!spec || typeof spec !== "object" || !(spec.openapi || spec.swagger) || !spec.paths)
    throw new Error("This doesn't look like an OpenAPI/Swagger document (missing openapi/swagger or paths).");

  const notes: string[] = [];
  const vars: Record<string, string> = { baseUrl: baseUrlOf(spec) };
  const requests: ImportedRequest[] = [];
  const isV2 = !!spec.swagger;

  // Which security scheme applies globally (first requirement wins).
  const schemes: Obj = (isV2 ? spec.securityDefinitions : spec.components?.securitySchemes) ?? {};
  const schemeFor = (op: Obj): Obj | null => {
    const req = (op.security ?? spec.security)?.[0];
    const name = req && Object.keys(req)[0];
    return name ? (deref(spec, schemes[name]) ?? null) : null;
  };

  for (const [path, rawItem] of Object.entries<any>(spec.paths)) {
    const item = deref(spec, rawItem) ?? {};
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const t = newTab();
      const method = m.toUpperCase();
      t.method = method;
      t.source = `${method} ${path}`;
      t.name = String(op.summary || op.operationId || `${method} ${path}`).slice(0, 120);

      const urlPath = path.replace(/\{([^}]+)\}/g, (_, n) => {
        vars[n] ??= "";
        return `{{${n}}}`;
      });
      t.url = `{{baseUrl}}${urlPath}`;

      // Parameters: path-level first, operation-level overrides by (in, name).
      const merged = new Map<string, Obj>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const d = deref(spec, p);
        if (d?.name) merged.set(`${d.in}:${d.name}`, d);
      }
      const params: KV[] = [];
      const headers: KV[] = [];
      let bodyParam: Obj | null = null;
      const formFields: [string, string][] = [];
      for (const p of merged.values()) {
        const schema = p.schema ?? p;
        const ex = p.example ?? schema.example ?? schema.default ?? (schema.enum?.[0] ?? "");
        const row = { ...emptyKV(), key: p.name, value: String(ex ?? ""), enabled: !!p.required };
        if (p.in === "query") params.push(row);
        else if (p.in === "header") headers.push(row);
        else if (p.in === "body") bodyParam = p;
        else if (p.in === "formData") formFields.push([p.name, String(ex ?? "")]);
      }
      t.params = [...params, emptyKV()];

      // Body
      let bodyMode: BodyMode = "none";
      let body = "";
      const rb = deref(spec, op.requestBody);
      if (rb?.content) {
        const types = Object.keys(rb.content);
        const ct = types.find((c) => c.includes("json")) ?? types.find((c) => c.includes("x-www-form-urlencoded")) ?? types[0];
        const media = rb.content[ct] ?? {};
        const ex = media.example ?? Object.values<any>(media.examples ?? {})[0]?.value;
        const sample = ex !== undefined ? ex : sampleFromSchema(spec, media.schema);
        if (ct.includes("json")) {
          bodyMode = "json";
          body = JSON.stringify(sample, null, 2);
        } else if (ct.includes("x-www-form-urlencoded")) {
          bodyMode = "form";
          body = sample && typeof sample === "object" ? Object.entries(sample).map(([k, v]) => `${k}=${v ?? ""}`).join("&") : "";
        } else {
          notes.push(`${t.source}: ${ct} body not supported yet, left empty`);
        }
      } else if (bodyParam) {
        bodyMode = "json";
        body = JSON.stringify(sampleFromSchema(spec, bodyParam.schema), null, 2);
      } else if (formFields.length) {
        bodyMode = "form";
        body = formFields.map(([k, v]) => `${k}=${v}`).join("&");
      }
      t.bodyMode = bodyMode;
      t.body = body;
      if (bodyMode === "json") headers.push({ ...emptyKV(), key: "Content-Type", value: "application/json" });
      if (bodyMode === "form") headers.push({ ...emptyKV(), key: "Content-Type", value: "application/x-www-form-urlencoded" });

      // Auth
      const sch = schemeFor(op);
      let authMode: AuthMode = "none";
      if (sch) {
        if (sch.type === "http" && sch.scheme === "bearer") {
          authMode = "bearer";
          t.authToken = "{{token}}";
          vars.token ??= "";
        } else if ((sch.type === "http" && sch.scheme === "basic") || sch.type === "basic") {
          authMode = "basic";
          t.authUser = "{{username}}";
          t.authPass = "{{password}}";
          vars.username ??= "";
          vars.password ??= "";
        } else if (sch.type === "apiKey" && sch.in === "header") {
          headers.push({ ...emptyKV(), key: sch.name, value: "{{apiKey}}" });
          vars.apiKey ??= "";
        } else if (sch.type === "apiKey" && sch.in === "query") {
          t.params = [{ ...emptyKV(), key: sch.name, value: "{{apiKey}}" }, ...t.params];
          vars.apiKey ??= "";
        } else if (sch.type === "oauth2") {
          // OpenAPI 3 keeps flows under `flows`; Swagger 2 puts one flow on the scheme itself.
          const f = sch.flows ?? {};
          const ac = f.authorizationCode ?? (sch.flow === "accessCode" ? sch : undefined);
          const cc = f.clientCredentials ?? (sch.flow === "application" ? sch : undefined);
          const flow = ac ?? cc ?? f.password ?? f.implicit;
          authMode = "oauth2";
          t.oauth = {
            ...defaultOAuth(),
            grant: ac ? "authorization_code" : f.password ? "password" : "client_credentials",
            authUrl: String(ac?.authorizationUrl ?? ""),
            tokenUrl: String(flow?.tokenUrl ?? ""),
            clientId: "{{clientId}}",
            clientSecret: "{{clientSecret}}",
            scope: Object.keys(flow?.scopes ?? {}).join(" "),
          };
          vars.clientId ??= "";
          vars.clientSecret ??= "";
          if (!ac && !cc && !f.password) {
            notes.push(`${t.source}: ${flow ? "implicit" : "unknown"} OAuth2 flow isn't supported, fill in the token URL yourself`);
          }
        } else if (sch.type === "openIdConnect") {
          authMode = "bearer";
          t.authToken = "{{token}}";
          vars.token ??= "";
          notes.push("OpenID Connect discovery isn't supported yet: requests use a {{token}} variable you fill in");
        }
      }
      t.authMode = authMode;
      t.headers = [...headers, emptyKV()];

      t.examples = examplesFrom(spec, op, isV2);

      const tag = String(op.tags?.[0] ?? "");
      requests.push({
        folder: tag ? [tag] : [],
        base: op.operationId ? String(op.operationId) : `${m}-${path}`,
        tab: t,
      });
    }
  }
  return { title: String(spec.info?.title ?? "API"), vars, requests, notes: [...new Set(notes)] };
}

/** Recursively add keys that exist in `fresh` but not in `current`; never overwrite or remove. */
export function addMissingKeys(current: any, fresh: any): any {
  if (current && fresh && typeof current === "object" && typeof fresh === "object" && !Array.isArray(current) && !Array.isArray(fresh)) {
    const out = { ...current };
    for (const [k, v] of Object.entries(fresh)) out[k] = k in current ? addMissingKeys(current[k], v) : v;
    return out;
  }
  return current;
}

/**
 * Re-import policy: the spec owns structure, the user owns values.
 * - parameter rows: keep the user's rows, add parameters the spec introduced
 * - headers: add missing, keep the user's
 * - JSON body: add newly introduced fields, keep user values; an empty body is taken from the spec
 * - url, name, auth and settings are never touched.
 */
export function mergeSpecInto(existing: RequestTab, fresh: RequestTab): RequestTab {
  const addRows = (cur: RequestTab["params"], inc: RequestTab["params"]) => {
    const have = new Set(cur.filter((r) => r.key).map((r) => r.key.toLowerCase()));
    const add = inc.filter((r) => r.key && !have.has(r.key.toLowerCase()));
    const filled = cur.filter((r) => r.key || r.value);
    return [...filled, ...add, emptyKV()];
  };
  const out: RequestTab = { ...existing, method: fresh.method, source: fresh.source };
  // new documented responses are added; ones you've edited or kept stay as they are
  const have = new Set(existing.examples.map((e) => e.name));
  out.examples = [...existing.examples, ...fresh.examples.filter((e) => !have.has(e.name))];
  out.params = addRows(existing.params, fresh.params);
  out.headers = addRows(existing.headers, fresh.headers);
  if (existing.bodyMode === "none" || !existing.body.trim()) {
    out.bodyMode = fresh.bodyMode;
    out.body = fresh.body;
  } else if (existing.bodyMode === "json" && fresh.bodyMode === "json") {
    try {
      const merged = addMissingKeys(JSON.parse(existing.body), JSON.parse(fresh.body));
      out.body = tryPrettyJson(JSON.stringify(merged)) ?? existing.body;
    } catch {
      /* body has {{variables}} or isn't strict JSON: leave it alone */
    }
  }
  return out;
}

/** What a pasted text is, without importing anything: drives the preview in the "from clipboard" dialog. */
export type SpecInfo =
  | { kind: "spec"; title: string; version: string; requests: number; names: string[]; notes: number }
  | { kind: "wsdl"; title: string; requests: number; names: string[]; notes: number }
  | { kind: "url"; url: string }
  | { kind: "empty" }
  | { kind: "other"; reason: string };

const PREVIEW_LIMIT = 3_000_000;

export function inspectSpec(text: string): SpecInfo {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (/^https?:\/\/\S+$/i.test(t)) return { kind: "url", url: t };
  if (t.startsWith("<") && isWsdl(t)) {
    try {
      const r = parseWsdlSync(t);
      return { kind: "wsdl", title: r.title, requests: r.requests.length, names: r.requests.slice(0, 6).map((q) => `POST ${q.folder.join("/")}/${q.tab.name}`), notes: r.notes.length };
    } catch (e) {
      return { kind: "other", reason: (e as Error).message };
    }
  }
  if (t.length > PREVIEW_LIMIT) return { kind: "other", reason: "Too large to preview, but Import will read it." };
  let doc: any;
  try {
    doc = parse(t);
  } catch (e) {
    return { kind: "other", reason: `Not valid JSON or YAML: ${String((e as Error).message).split("\n")[0]}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { kind: "other", reason: "That isn't an OpenAPI or Swagger document." };
  if (doc.info && Array.isArray(doc.item)) return { kind: "other", reason: "This is a Postman collection: use Import > Postman collection or environment file." };
  if (Array.isArray(doc.log?.entries)) return { kind: "other", reason: "This is a HAR recording: use Import > HAR recording." };
  if (!(doc.openapi || doc.swagger)) return { kind: "other", reason: "Missing the openapi (or swagger) version field." };
  if (!doc.paths || typeof doc.paths !== "object") return { kind: "other", reason: "The document has no paths." };
  try {
    const r = parseOpenApi(t);
    if (!r.requests.length) return { kind: "other", reason: "The document has no operations (GET, POST, ...) to import." };
    return { kind: "spec", title: r.title, version: String(doc.openapi ?? `Swagger ${doc.swagger}`), requests: r.requests.length, names: r.requests.slice(0, 6).map((q) => `${q.tab.method} ${q.tab.source?.replace(/^\w+ /, "") ?? q.tab.url}`), notes: r.notes.length };
  } catch (e) {
    return { kind: "other", reason: (e as Error).message };
  }
}
