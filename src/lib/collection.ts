import { parse, stringify } from "yaml";
import type { AuthMode, BodyMode, Environment, FormPart, KV, OAuthConfig, RequestKind, RequestTab } from "./types";
import { defaultOAuth, emptyKV, emptyPart, newTab, uid } from "./util";
import { foldParamsIntoUrl, syncParams } from "./query";
import { KEYCHAIN_MARKER, keychainDelete, keychainEvents, keychainGet, keychainSet, secretAccount, secretStore, type SecretStore } from "./keychain";
import { basename, dirname, join, listFiles, makeDir, pathExists, readText, removePath, writeText } from "./fs";

/**
 * On-disk format. Design rules (these are what keep Git diffs clean):
 *  - no generated IDs, no sequence numbers: order comes from file names
 *  - keys are always emitted in the same order, defaults are omitted
 *  - multi-line values (bodies) use YAML literal blocks, so line diffs are real line diffs
 */
const YAML_OPTS = { lineWidth: 0, blockQuote: "literal" as const, indent: 2 };

const kvOut = (rows: KV[]) =>
  rows
    .filter((r) => r.key || r.value)
    .map((r) => ({ key: r.key, value: r.value, ...(r.enabled ? {} : { enabled: false }) }));

const partsIn = (v: unknown): FormPart[] => {
  const rows = (Array.isArray(v) ? v : []).map((p: any): FormPart => {
    const file = typeof p?.file === "string";
    return {
      id: uid(),
      key: String(p?.key ?? ""),
      value: String(file ? p.file : (p?.value ?? "")),
      kind: file ? "file" : "text",
      enabled: p?.enabled !== false,
      ...(p?.contentType ? { contentType: String(p.contentType) } : {}),
    };
  });
  return [...rows, emptyPart()];
};

export function serializeRequest(t: RequestTab): string {
  const doc: Record<string, unknown> = { name: t.name };
  if (t.kind !== "http") doc.type = t.kind === "sio" ? "socketio" : t.kind;
  if (t.kind !== "graphql" && t.kind !== "ws" && t.kind !== "sio" && t.kind !== "grpc" && t.kind !== "mcp") doc.method = t.method;
  doc.url = foldParamsIntoUrl(t.url, t.params);
  if (t.source) doc.source = t.source;
  const params = kvOut(t.params.filter((p) => !p.enabled)); // enabled ones are in the url
  const headers = kvOut(t.headers);
  if (params.length) doc.params = params;
  if (headers.length) doc.headers = headers;
  if (t.bodyMode === "multipart") {
    const parts = t.formParts
      .filter((p) => p.key || p.value)
      .map((p) => ({
        key: p.key,
        ...(p.kind === "file" ? { file: p.value } : { value: p.value }),
        ...(p.contentType?.trim() ? { contentType: p.contentType.trim() } : {}),
        ...(p.enabled ? {} : { enabled: false }),
      }));
    doc.body = { mode: "multipart", parts };
  } else if (t.bodyMode !== "none") doc.body = { mode: t.bodyMode, content: t.body };
  const auth = authOut(t);
  if (auth) doc.auth = auth;
  if (t.kind === "graphql") {
    doc.graphql = { query: t.gql.query, ...(t.gql.variables.trim() ? { variables: t.gql.variables } : {}), ...(t.gql.operation ? { operation: t.gql.operation } : {}) };
  }
  if (t.kind === "ws") {
    doc.websocket = {
      ...(t.ws.protocols.trim() ? { protocols: t.ws.protocols } : {}),
      ...(t.ws.composer.trim() ? { message: t.ws.composer } : {}),
      ...(t.ws.messages.length ? { saved: t.ws.messages.map((m) => ({ name: m.name, body: m.body })) } : {}),
    };
  }
  if (t.kind === "sio") {
    const s = t.sio;
    doc.socketio = {
      ...(s.namespace.trim() ? { namespace: s.namespace } : {}),
      ...(s.path.trim() ? { path: s.path } : {}),
      ...(s.auth.trim() ? { auth: s.auth } : {}),
      ...(s.event.trim() ? { event: s.event } : {}),
      ...(s.composer.trim() ? { message: s.composer } : {}),
      ...(s.ack ? { ack: true } : {}),
      ...(s.messages.length ? { saved: s.messages.map((m) => ({ name: m.name, event: m.event, body: m.body })) } : {}),
    };
  }
  if (t.kind === "mcp") {
    doc.mcp = {
      transport: t.mcp.transport,
      ...(t.mcp.transport === "stdio" ? { command: t.mcp.command, ...(t.mcp.args.trim() ? { args: t.mcp.args } : {}), ...(kvOut(t.mcp.env).length ? { env: kvOut(t.mcp.env) } : {}) } : {}),
    };
  }
  if (t.kind === "grpc") {
    doc.grpc = {
      source: t.grpc.source,
      ...(t.grpc.source === "proto" ? { protoFiles: t.grpc.protoFiles, ...(t.grpc.importPaths.length ? { importPaths: t.grpc.importPaths } : {}) } : {}),
      method: t.grpc.method,
      message: t.grpc.message,
      ...(t.grpc.tls ? {} : { tls: false }),
    };
  }
  if (t.examples.length) {
    doc.examples = t.examples.map((e) => ({
      name: e.name,
      status: e.status,
      ...(kvOut(e.headers).length ? { headers: kvOut(e.headers) } : {}),
      ...(e.body ? { body: e.body } : {}),
      ...(e.delayMs ? { delay: e.delayMs } : {}),
    }));
  }
  const tests = t.assertions.map((a) => ({
    kind: a.kind,
    ...(a.path ? { path: a.path } : {}),
    op: a.op,
    ...(a.op === "exists" ? {} : { value: a.value }),
    ...(a.enabled ? {} : { enabled: false }),
  }));
  if (tests.length) doc.tests = tests;
  if (t.captures.length) doc.capture = t.captures.map((c) => ({ variable: c.variable, from: c.from, path: c.path }));
  const scripts: Record<string, string> = {};
  if (t.preScript.trim()) scripts.pre = t.preScript;
  if (t.postScript.trim()) scripts.post = t.postScript;
  if (Object.keys(scripts).length) doc.scripts = scripts;
  const settings: Record<string, unknown> = {};
  if (!t.followRedirects) settings.followRedirects = false;
  if (t.insecure) settings.insecure = true;
  if (t.timeoutMs !== 30000) settings.timeoutMs = t.timeoutMs;
  if (Object.keys(settings).length) doc.settings = settings;
  return stringify(doc, YAML_OPTS);
}

const authOut = (t: RequestTab): Record<string, unknown> | null => {
  if (t.authMode === "inherit") return { mode: "inherit" };
  if (t.authMode === "bearer") return { mode: "bearer", token: t.authToken };
  if (t.authMode === "basic") return { mode: "basic", username: t.authUser, password: t.authPass };
  if (t.authMode === "oauth2") return { mode: "oauth2", ...oauthOut(t.oauth) };
  return null;
};

const authIn = (a: any): Pick<RequestTab, "authMode" | "authToken" | "authUser" | "authPass" | "oauth"> => ({
  authMode: (a?.mode ?? "none") as AuthMode,
  authToken: String(a?.token ?? ""),
  authUser: String(a?.username ?? ""),
  authPass: String(a?.password ?? ""),
  oauth:
    a?.mode === "oauth2"
      ? {
          ...defaultOAuth(),
          grant: a.grant ?? "client_credentials",
          authUrl: String(a.authUrl ?? ""),
          tokenUrl: String(a.tokenUrl ?? ""),
          clientId: String(a.clientId ?? ""),
          clientSecret: String(a.clientSecret ?? ""),
          scope: String(a.scope ?? ""),
          username: String(a.username ?? ""),
          password: String(a.password ?? ""),
          redirectPort: Number(a.redirectPort ?? 8976),
          pkce: a.pkce !== false,
          clientAuth: a.clientAuth === "body" ? "body" : "basic",
          prefix: String(a.prefix ?? "Bearer"),
          extra: kvIn(a.extra),
        }
      : defaultOAuth(),
});

/** Only non-default OAuth fields are written, so a plain client_credentials setup stays a few lines. */
function oauthOut(o: OAuthConfig): Record<string, unknown> {
  const d = defaultOAuth();
  const out: Record<string, unknown> = { grant: o.grant };
  const keep = (k: keyof OAuthConfig) => o[k] !== "" && o[k] !== d[k];
  if (o.grant === "authorization_code" && o.authUrl) out.authUrl = o.authUrl;
  out.tokenUrl = o.tokenUrl;
  out.clientId = o.clientId;
  if (o.clientSecret) out.clientSecret = o.clientSecret;
  if (o.scope) out.scope = o.scope;
  if (o.grant === "password") {
    out.username = o.username;
    out.password = o.password;
  }
  if (o.grant === "authorization_code") {
    if (o.redirectPort !== d.redirectPort) out.redirectPort = o.redirectPort;
    if (!o.pkce) out.pkce = false;
  }
  if (keep("clientAuth")) out.clientAuth = o.clientAuth;
  if (keep("prefix")) out.prefix = o.prefix;
  const extra = kvOut(o.extra);
  if (extra.length) out.extra = extra;
  return out;
}

const kvIn = (rows: unknown): KV[] => {
  const out: KV[] = Array.isArray(rows)
    ? rows.map((r: any) => ({
        id: uid(),
        key: String(r?.key ?? ""),
        value: String(r?.value ?? ""),
        enabled: r?.enabled !== false,
      }))
    : [];
  out.push(emptyKV());
  return out;
};

/* ------------------------- shared (linked) requests ------------------------- */

/**
 * A request file can be a link to a request kept elsewhere, so one definition serves many folders and
 * collections: the file holds only `use: <path to the shared .req.yaml>` (relative to the link, or absolute).
 * The content comes from the shared file; headers, auth and variables still come from where the link sits.
 */
const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/") >= 0 ? file.lastIndexOf("/") : 0);

/** Resolve `.` and `..` in a slash path. */
export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !abs) out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** The absolute path a link file points at, or null when the text is an ordinary request. */
export function linkTarget(text: string, file: string): string | null {
  if (/^(method|url|type):/m.test(text)) return null;
  const m = /^use:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const raw = m[1].replace(/^(["'])(.*)\1$/, "$2");
  return normalizePath(raw.startsWith("/") ? raw : `${dirOf(file)}/${raw}`);
}

/** Path of `to` as seen from the folder `fromDir` (both absolute, slash separated). */
export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split("/").filter(Boolean);
  const b = normalizePath(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** The text of a link file that points at `target`. */
export const linkText = (linkFile: string, target: string) => `use: ${relativePath(dirOf(linkFile), target)}\n`;

/** Read a request file, following a link to the shared request. The returned tab keeps the link's own path as `file`. */
export async function readRequest(file: string): Promise<RequestTab> {
  const text = await readText(file);
  if (text === null) throw new Error("File no longer exists");
  const target = linkTarget(text, file);
  if (!target) return parseRequest(text, file);
  const shared = await readText(target);
  if (shared === null) throw new Error(`The shared request is missing: ${target}`);
  if (linkTarget(shared, target)) throw new Error(`A shared request can't itself be a link: ${target}`);
  return { ...parseRequest(shared, file), linkTo: target };
}

export function parseRequest(text: string, file: string): RequestTab {
  const tab = parseRequestRaw(text, file);
  // "Saved" means the canonical form: a hand-edited file isn't dirty just because its formatting differs.
  return { ...tab, saved: serializeRequest(tab) };
}

function parseRequestRaw(text: string, file: string): RequestTab {
  const d: any = parse(text) ?? {};
  const t = newTab();
  return {
    ...t,
    name: String(d.name ?? basename(file).replace(/\.req\.ya?ml$/, "")),
    kind: (d.type === "socketio" ? "sio" : ["graphql", "sse", "ws", "grpc", "mcp"].includes(d.type) ? d.type : "http") as RequestKind,
    method: String(d.method ?? "GET").toUpperCase(),
    gql: { query: String(d.graphql?.query ?? ""), variables: String(d.graphql?.variables ?? ""), operation: String(d.graphql?.operation ?? "") },
    ws: {
      composer: String(d.websocket?.message ?? ""),
      protocols: String(d.websocket?.protocols ?? ""),
      messages: (Array.isArray(d.websocket?.saved) ? d.websocket.saved : []).map((m: any) => ({ id: uid(), name: String(m?.name ?? ""), body: String(m?.body ?? "") })),
    },
    sio: {
      namespace: String(d.socketio?.namespace ?? ""),
      path: String(d.socketio?.path ?? ""),
      auth: String(d.socketio?.auth ?? ""),
      event: String(d.socketio?.event ?? ""),
      composer: String(d.socketio?.message ?? ""),
      ack: d.socketio?.ack === true,
      messages: (Array.isArray(d.socketio?.saved) ? d.socketio.saved : []).map((m: any) => ({ id: uid(), name: String(m?.name ?? ""), event: String(m?.event ?? ""), body: String(m?.body ?? "") })),
    },
    mcp: { transport: d.mcp?.transport === "stdio" ? "stdio" : "http", command: String(d.mcp?.command ?? ""), args: String(d.mcp?.args ?? ""), env: kvIn(d.mcp?.env) },
    grpc: {
      source: d.grpc?.source === "proto" ? "proto" : "reflection",
      protoFiles: Array.isArray(d.grpc?.protoFiles) ? d.grpc.protoFiles.map(String) : [],
      importPaths: Array.isArray(d.grpc?.importPaths) ? d.grpc.importPaths.map(String) : [],
      method: String(d.grpc?.method ?? ""),
      message: String(d.grpc?.message ?? "{}"),
      tls: d.grpc?.tls !== false,
    },
    source: d.source ? String(d.source) : undefined,
    ...syncParams(String(d.url ?? ""), kvIn(d.params)),
    headers: kvIn(d.headers),
    bodyMode: (d.body?.mode ?? "none") as BodyMode,
    body: String(d.body?.content ?? ""),
    formParts: partsIn(d.body?.parts),
    ...authIn(d.auth),
    examples: (Array.isArray(d.examples) ? d.examples : []).map((e: any) => ({
      id: uid(),
      name: String(e?.name ?? "Example"),
      status: Number(e?.status ?? 200),
      headers: kvIn(e?.headers),
      body: String(e?.body ?? ""),
      delayMs: Number(e?.delay ?? 0),
    })),
    assertions: (Array.isArray(d.tests) ? d.tests : []).map((a: any) => ({
      id: uid(),
      enabled: a?.enabled !== false,
      kind: a?.kind ?? "status",
      path: String(a?.path ?? ""),
      op: a?.op ?? "eq",
      value: String(a?.value ?? ""),
    })),
    captures: (Array.isArray(d.capture) ? d.capture : []).map((c: any) => ({
      id: uid(),
      variable: String(c?.variable ?? ""),
      from: c?.from === "header" ? "header" : "json",
      path: String(c?.path ?? ""),
    })),
    preScript: String(d.scripts?.pre ?? ""),
    postScript: String(d.scripts?.post ?? ""),
    followRedirects: d.settings?.followRedirects !== false,
    insecure: d.settings?.insecure === true,
    timeoutMs: Number(d.settings?.timeoutMs ?? 30000),
    file,
    saved: text,
  };
}

export const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let p = join(dir, base + ext);
  for (let i = 2; await pathExists(p); i++) p = join(dir, `${base}-${i}${ext}`);
  return p;
}

export const requestPath = (dir: string, name: string) => uniquePath(dir, slug(name), ".req.yaml");

/* ------------------------------ collections ------------------------------ */

export async function initCollection(root: string, name: string) {
  await writeText(join(root, "cairn.yaml"), stringify({ name }, YAML_OPTS));
  // Secrets live in .cairn/ which is git-ignored by default.
  const gi = join(root, ".gitignore");
  const cur = (await readText(gi)) ?? "";
  if (!/^\.cairn\/?$/m.test(cur)) await writeText(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".cairn/\n");
  await makeDir(join(root, "environments"));
}

export type CollectionMeta = { name: string; openapi?: { source: string } };

/** The collection file is cairn.yaml; collections made before the rename have reqnest.yaml, which is still read. */
async function readMetaText(root: string): Promise<string | null> {
  return (await readText(join(root, "cairn.yaml"))) ?? (await readText(join(root, "reqnest.yaml")));
}

export async function readCollectionMeta(root: string): Promise<CollectionMeta | null> {
  const t = await readMetaText(root);
  if (t === null) return null;
  const d: any = parse(t) ?? {};
  return { name: String(d.name ?? basename(root)), openapi: d.openapi?.source ? { source: String(d.openapi.source) } : undefined };
}

export async function writeCollectionMeta(root: string, meta: CollectionMeta) {
  await writeText(join(root, "cairn.yaml"), stringify(meta, YAML_OPTS));
}

export async function readCollectionName(root: string): Promise<string | null> {
  const t = await readMetaText(root);
  if (t === null) return null;
  return String((parse(t) as any)?.name ?? basename(root));
}

/* ------------------------------ environments ----------------------------- */

const secretsPath = (root: string) => join(root, ".cairn", "secrets.yaml");

async function readSecrets(root: string): Promise<Record<string, Record<string, string>>> {
  const t = (await readText(secretsPath(root))) ?? (await readText(join(root, ".reqnest", "secrets.yaml")));
  return (t && (parse(t) as any)) || {};
}

export async function loadEnvironments(root: string): Promise<Environment[]> {
  const dir = join(root, "environments");
  const files = await listFiles(dir, ".env.yaml");
  const secrets = await readSecrets(root);
  const envs: Environment[] = [];
  for (const file of files) {
    const d: any = parse((await readText(file)) ?? "") ?? {};
    const key = basename(file);
    const missing: string[] = [];
    const vars: KV[] = [];
    for (const v of Array.isArray(d.vars) ? d.vars : []) {
      const isSecret = v?.secret === true;
      let value = isSecret ? String(secrets[key]?.[v.key] ?? "") : String(v?.value ?? "");
      if (isSecret && value === KEYCHAIN_MARKER) {
        // the value is in the Keychain: fetch it; if that fails the variable stays empty and is reported
        value = (await keychainGet(secretAccount(root, file, String(v.key))).catch(() => null)) ?? "";
        if (!value) missing.push(String(v.key));
      }
      vars.push({ id: uid(), key: String(v?.key ?? ""), value, enabled: v?.enabled !== false, secret: isSecret });
    }
    vars.push(emptyKV());
    envs.push({ id: file, name: String(d.name ?? key), vars, file, ...(typeof d.extends === "string" && d.extends ? { extends: d.extends } : {}), ...(missing.length ? { missing } : {}) });
  }
  return envs;
}

/** The environment a name refers to (exact match first, then ignoring case). */
export const findEnvByName = (envs: Environment[], name: string) => envs.find((e) => e.name === name) ?? envs.find((e) => e.name.toLowerCase() === name.toLowerCase());

/** The parents of an environment, nearest first. Stops at a missing parent or a cycle. */
export function envAncestors(envs: Environment[], env: Environment): Environment[] {
  const out: Environment[] = [];
  const seen = new Set([env.id]);
  for (let cur = env; cur.extends; ) {
    const parent = findEnvByName(envs, cur.extends);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent);
    cur = parent;
  }
  return out;
}

/**
 * What a request sees: the environment's own variables on top of everything it extends.
 * Disabled variables don't count at any level, so switching one off in a child doesn't hide the parent's value.
 */
export function effectiveEnv(envs: Environment[], env: Environment | undefined, also: Environment[] = []): Environment | undefined {
  if (!env) return env;
  const layers = [...envAncestors(envs, env).reverse(), env];
  for (const extra of also) layers.push(...envAncestors(envs, extra).reverse(), extra);
  if (layers.length === 1) return env;
  const merged = new Map<string, KV>();
  for (const l of layers) for (const v of l.vars) if (v.enabled && v.key) merged.set(v.key, v);
  return { ...env, vars: [...merged.values()] };
}

export async function saveEnvironment(root: string, env: Environment, store: SecretStore = secretStore.current): Promise<string> {
  const file = env.file ?? (await uniquePath(join(root, "environments"), slug(env.name), ".env.yaml"));
  const vars = env.vars
    .filter((v) => v.key)
    .map((v) => ({
      key: v.key,
      value: v.secret ? "" : v.value,
      ...(v.enabled ? {} : { enabled: false }),
      ...(v.secret ? { secret: true } : {}),
    }));
  await writeText(file, stringify({ name: env.name, ...(env.extends ? { extends: env.extends } : {}), vars }, YAML_OPTS));

  const all = await readSecrets(root);
  const before = all[basename(file)] ?? {};
  const mine: Record<string, string> = {};
  let keychainError: string | null = null;
  for (const v of env.vars) {
    if (!(v.secret && v.key)) continue;
    if (store === "keychain" && v.value) {
      try {
        await keychainSet(secretAccount(root, file, v.key), v.value);
        mine[v.key] = KEYCHAIN_MARKER;
        continue;
      } catch (e) {
        // never lose a value because the Keychain said no: keep it in the file and tell the user
        keychainError ??= String((e as Error).message ?? e);
      }
    }
    mine[v.key] = v.value;
  }
  // entries that were in the Keychain and no longer are (moved back to the file, removed, no longer secret)
  for (const [k, val] of Object.entries(before)) if (val === KEYCHAIN_MARKER && mine[k] !== KEYCHAIN_MARKER) await keychainDelete(secretAccount(root, file, k)).catch(() => {});
  if (Object.keys(mine).length) all[basename(file)] = mine;
  else delete all[basename(file)];
  await writeText(secretsPath(root), stringify(all, YAML_OPTS));
  if (keychainError) keychainEvents.onError?.(`${keychainError} The value was kept in the secrets file instead.`);
  return file;
}

/** An environment is being deleted: drop its secrets from the Keychain and from the secrets file. */
export async function forgetEnvironmentSecrets(root: string, env: Environment): Promise<void> {
  if (!env.file) return;
  const all = await readSecrets(root);
  const base = basename(env.file);
  for (const [k, val] of Object.entries(all[base] ?? {})) if (val === KEYCHAIN_MARKER) await keychainDelete(secretAccount(root, env.file, k)).catch(() => {});
  if (base in all) {
    delete all[base];
    await writeText(secretsPath(root), stringify(all, YAML_OPTS));
  }
}

/** Move every secret of a collection to the Keychain or back to the file. Returns how many values moved. */
export async function migrateSecrets(root: string, to: SecretStore): Promise<number> {
  let moved = 0;
  for (const env of await loadEnvironments(root)) {
    const n = env.vars.filter((v) => v.secret && v.key && v.value).length;
    if (!n) continue;
    await saveEnvironment(root, env, to);
    moved += n;
  }
  return moved;
}

export { dirname };


/* ------------------- folder / collection defaults (folder.yaml) ------------------- */

/**
 * Defaults for every request below a folder: headers, auth and scripts. They live in
 * `<folder>/folder.yaml` (the collection root has one too). They're edited through the same
 * panels as a request, so a defaults object is held as a RequestTab with only those fields used.
 */
export const DEFAULTS_FILE = "folder.yaml";

export function serializeDefaults(t: RequestTab): string {
  const doc: Record<string, unknown> = {};
  const vars = kvOut(t.vars ?? []);
  if (vars.length) doc.vars = vars;
  const headers = kvOut(t.headers);
  if (headers.length) doc.headers = headers;
  const auth = t.authMode === "inherit" ? null : authOut(t);
  if (auth) doc.auth = auth;
  const scripts: Record<string, string> = {};
  if (t.preScript.trim()) scripts.pre = t.preScript;
  if (t.postScript.trim()) scripts.post = t.postScript;
  if (Object.keys(scripts).length) doc.scripts = scripts;
  return Object.keys(doc).length ? stringify(doc, YAML_OPTS) : "";
}

export function parseDefaults(text: string | null): RequestTab {
  const d: any = (text && parse(text)) || {};
  return {
    ...newTab(),
    name: "defaults",
    vars: kvIn(d.vars),
    headers: kvIn(d.headers),
    ...authIn(d.auth),
    preScript: String(d.scripts?.pre ?? ""),
    postScript: String(d.scripts?.post ?? ""),
  };
}

export async function loadDefaults(dir: string): Promise<RequestTab> {
  return parseDefaults(await readText(join(dir, DEFAULTS_FILE)));
}

export async function saveDefaults(dir: string, t: RequestTab) {
  const text = serializeDefaults(t);
  const file = join(dir, DEFAULTS_FILE);
  if (text) await writeText(file, text);
  else if (await pathExists(file)) await removePath(file); // nothing left to say: don't leave an empty file around
}

export type ChainLink = { dir: string; label: string; defaults: RequestTab };

/** Defaults from the collection root down to the folder containing `file`, outermost first. */
export async function loadChain(root: string, file: string, rootLabel: string): Promise<ChainLink[]> {
  if (!file.startsWith(root + "/")) return [];
  const rel = dirname(file).slice(root.length).split("/").filter(Boolean);
  const dirs = [root, ...rel.map((_, i) => join(root, ...rel.slice(0, i + 1)))];
  return Promise.all(dirs.map(async (dir, i) => ({ dir, label: i === 0 ? rootLabel : basename(dir), defaults: await loadDefaults(dir) })));
}
