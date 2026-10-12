import { parse, stringify } from "yaml";
import type { AuthMode, BodyMode, Environment, KV, RequestTab } from "./types";
import { emptyKV, newTab, uid } from "./util";
import { basename, dirname, join, listFiles, makeDir, pathExists, readText, writeText } from "./fs";

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

export function serializeRequest(t: RequestTab): string {
  const doc: Record<string, unknown> = { name: t.name, method: t.method, url: t.url };
  if (t.source) doc.source = t.source;
  const params = kvOut(t.params);
  const headers = kvOut(t.headers);
  if (params.length) doc.params = params;
  if (headers.length) doc.headers = headers;
  if (t.bodyMode !== "none") doc.body = { mode: t.bodyMode, content: t.body };
  if (t.authMode === "bearer") doc.auth = { mode: "bearer", token: t.authToken };
  if (t.authMode === "basic") doc.auth = { mode: "basic", username: t.authUser, password: t.authPass };
  const settings: Record<string, unknown> = {};
  if (!t.followRedirects) settings.followRedirects = false;
  if (t.insecure) settings.insecure = true;
  if (t.timeoutMs !== 30000) settings.timeoutMs = t.timeoutMs;
  if (Object.keys(settings).length) doc.settings = settings;
  return stringify(doc, YAML_OPTS);
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

export function parseRequest(text: string, file: string): RequestTab {
  const d: any = parse(text) ?? {};
  const t = newTab();
  return {
    ...t,
    name: String(d.name ?? basename(file).replace(/\.req\.ya?ml$/, "")),
    method: String(d.method ?? "GET").toUpperCase(),
    url: String(d.url ?? ""),
    source: d.source ? String(d.source) : undefined,
    params: kvIn(d.params),
    headers: kvIn(d.headers),
    bodyMode: (d.body?.mode ?? "none") as BodyMode,
    body: String(d.body?.content ?? ""),
    authMode: (d.auth?.mode ?? "none") as AuthMode,
    authToken: String(d.auth?.token ?? ""),
    authUser: String(d.auth?.username ?? ""),
    authPass: String(d.auth?.password ?? ""),
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
  await writeText(join(root, "reqnest.yaml"), stringify({ name }, YAML_OPTS));
  // Secrets live in .reqnest/ which is git-ignored by default.
  const gi = join(root, ".gitignore");
  const cur = (await readText(gi)) ?? "";
  if (!/^\.reqnest\/?$/m.test(cur)) await writeText(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".reqnest/\n");
  await makeDir(join(root, "environments"));
}

export type CollectionMeta = { name: string; openapi?: { source: string } };

export async function readCollectionMeta(root: string): Promise<CollectionMeta | null> {
  const t = await readText(join(root, "reqnest.yaml"));
  if (t === null) return null;
  const d: any = parse(t) ?? {};
  return { name: String(d.name ?? basename(root)), openapi: d.openapi?.source ? { source: String(d.openapi.source) } : undefined };
}

export async function writeCollectionMeta(root: string, meta: CollectionMeta) {
  await writeText(join(root, "reqnest.yaml"), stringify(meta, YAML_OPTS));
}

export async function readCollectionName(root: string): Promise<string | null> {
  const t = await readText(join(root, "reqnest.yaml"));
  if (t === null) return null;
  return String((parse(t) as any)?.name ?? basename(root));
}

/* ------------------------------ environments ----------------------------- */

const secretsPath = (root: string) => join(root, ".reqnest", "secrets.yaml");

async function readSecrets(root: string): Promise<Record<string, Record<string, string>>> {
  const t = await readText(secretsPath(root));
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
    const vars: KV[] = (Array.isArray(d.vars) ? d.vars : []).map((v: any) => {
      const isSecret = v?.secret === true;
      return {
        id: uid(),
        key: String(v?.key ?? ""),
        value: isSecret ? String(secrets[key]?.[v.key] ?? "") : String(v?.value ?? ""),
        enabled: v?.enabled !== false,
        secret: isSecret,
      };
    });
    vars.push(emptyKV());
    envs.push({ id: file, name: String(d.name ?? key), vars, file });
  }
  return envs;
}

export async function saveEnvironment(root: string, env: Environment): Promise<string> {
  const file = env.file ?? (await uniquePath(join(root, "environments"), slug(env.name), ".env.yaml"));
  const vars = env.vars
    .filter((v) => v.key)
    .map((v) => ({
      key: v.key,
      value: v.secret ? "" : v.value,
      ...(v.enabled ? {} : { enabled: false }),
      ...(v.secret ? { secret: true } : {}),
    }));
  await writeText(file, stringify({ name: env.name, vars }, YAML_OPTS));

  const all = await readSecrets(root);
  const mine: Record<string, string> = {};
  for (const v of env.vars) if (v.secret && v.key) mine[v.key] = v.value;
  if (Object.keys(mine).length) all[basename(file)] = mine;
  else delete all[basename(file)];
  await writeText(secretsPath(root), stringify(all, YAML_OPTS));
  return file;
}

export { dirname };
