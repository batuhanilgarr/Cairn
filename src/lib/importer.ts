import type { Environment, RequestTab } from "./types";
import type { ImportedFolder, ImportedRequest } from "./openapi";
import { detectPostman, parsePostman, parsePostmanEnvironment } from "./postman";
import { mergeSpecInto } from "./openapi";
import { emptyKV, uid } from "./util";
import { join, listFilesRecursive, readText, writeText } from "./fs";
import { loadDefaults, loadEnvironments, parseRequest, saveDefaults, saveEnvironment, serializeRequest, slug, uniquePath } from "./collection";

export type WriteSummary = {
  created: number;
  updated: number;
  unchanged: number;
  /** Requests in the collection whose source operation is gone from the spec. Never deleted automatically. */
  removed: string[];
};

/**
 * Write imported requests into the collection.
 * With `sync`, requests are matched to existing files by their `source` ("POST /pets") so a
 * re-import updates in place (see mergeSpecInto for the policy) instead of duplicating.
 */
export async function writeImport(root: string, reqs: ImportedRequest[], sync: boolean): Promise<WriteSummary> {
  const existing = new Map<string, { path: string; tab: RequestTab }>();
  if (sync) {
    for (const path of await listFilesRecursive(root, ".req.yaml")) {
      const text = await readText(path);
      if (text === null) continue;
      const tab = parseRequest(text, path);
      if (tab.source) existing.set(tab.source, { path, tab });
    }
  }
  const s: WriteSummary = { created: 0, updated: 0, unchanged: 0, removed: [] };
  const seen = new Set<string>();
  for (const r of reqs) {
    const src = r.tab.source;
    if (src) seen.add(src);
    const hit = src ? existing.get(src) : undefined;
    if (hit) {
      const merged = serializeRequest(mergeSpecInto(hit.tab, r.tab));
      if (merged === serializeRequest(hit.tab)) s.unchanged++;
      else {
        await writeText(hit.path, merged);
        s.updated++;
      }
      continue;
    }
    const dir = join(root, ...r.folder.map(slug));
    await writeText(await uniquePath(dir, slug(r.base), ".req.yaml"), serializeRequest({ ...r.tab, file: null, saved: null }));
    s.created++;
  }
  for (const src of existing.keys()) if (!seen.has(src)) s.removed.push(src);
  return s;
}

/** Create or extend an environment: adds missing variables, never overwrites values the user has set. */
export async function ensureEnvironment(root: string, name: string, vars: Record<string, string>, secrets: string[] = []): Promise<Environment> {
  const envs = await loadEnvironments(root);
  const file = join(root, "environments", `${slug(name)}.env.yaml`);
  const env: Environment = envs.find((e) => e.file === file) ?? { id: uid(), name, vars: [emptyKV()], file };
  const have = new Map(env.vars.filter((v) => v.key).map((v) => [v.key, v]));
  const added = Object.entries(vars).filter(([k]) => !have.has(k));
  for (const v of env.vars) if (v.key === "baseUrl" && !v.value && vars.baseUrl) v.value = vars.baseUrl;
  env.vars = [
    ...env.vars.filter((v) => v.key),
    ...added.map(([key, value]) => ({ ...emptyKV(), key, value, secret: secrets.includes(key) })),
    emptyKV(),
  ];
  await saveEnvironment(root, env);
  return { ...env, id: file, file };
}


/**
 * Write folder-level defaults (variables, auth, headers, scripts) of an import as each folder's folder.yaml.
 * A folder that already has settings keeps them: only what is missing is added, so a re-import never clobbers your edits.
 */
export async function writeFolderDefaults(root: string, folders: ImportedFolder[]): Promise<number> {
  let written = 0;
  for (const f of folders) {
    const dir = join(root, ...f.path.map(slug));
    const have = await loadDefaults(dir);
    const haveVars = new Set((have.vars ?? []).map((v) => v.key));
    const merged = {
      ...f.defaults,
      ...(have.authMode !== "none" ? { authMode: have.authMode, authToken: have.authToken, authUser: have.authUser, authPass: have.authPass, oauth: have.oauth } : {}),
      headers: [...have.headers.filter((h) => h.key), ...f.defaults.headers.filter((h) => h.key && !have.headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())), emptyKV()],
      vars: [...(have.vars ?? []).filter((v) => v.key), ...(f.defaults.vars ?? []).filter((v) => v.key && !haveVars.has(v.key)), emptyKV()],
      preScript: have.preScript.trim() ? have.preScript : f.defaults.preScript,
      postScript: have.postScript.trim() ? have.postScript : f.defaults.postScript,
    };
    await saveDefaults(dir, merged);
    written++;
  }
  return written;
}

export type PostmanImport = {
  collections: { title: string; requests: number }[];
  environments: { name: string; vars: number; secrets: number }[];
  /** Postman globals: app-wide, so the caller puts them in Settings > Variables. */
  globals: { key: string; value: string; secret?: boolean }[];
  /** How many credentials were moved out of the files into global variables. */
  protectedCredentials: number;
  folders: number;
  skippedFiles: string[];
  notes: string[];
  /** The last environment written, to select it afterwards. */
  lastEnvId?: string;
};

/**
 * Import Postman exports: collections (each into its own folder, with folder-level auth/scripts/variables),
 * environments (secret variables stay secret) and globals. Files that aren't Postman exports are skipped and listed.
 */
export async function importPostmanFiles(root: string, files: string[]): Promise<PostmanImport> {
  const out: PostmanImport = { collections: [], environments: [], globals: [], protectedCredentials: 0, folders: 0, skippedFiles: [], notes: [] };
  for (const file of files) {
    const text = await readText(file);
    const name = file.slice(file.lastIndexOf("/") + 1);
    const kind = text ? detectPostman(text) : "unknown";
    try {
      if (kind === "collection") {
        const parsed = parsePostman(text!);
        await writeImport(root, parsed.requests, false);
        out.folders += await writeFolderDefaults(root, parsed.folders ?? []);
        const secrets = Object.entries(parsed.secrets ?? {});
        out.globals.push(...secrets.map(([key, value]) => ({ key, value, secret: true })));
        out.protectedCredentials += secrets.length;
        out.collections.push({ title: parsed.title, requests: parsed.requests.length });
        out.notes.push(...parsed.notes.map((n) => `${parsed.title}: ${n}`));
      } else if (kind === "environment" || kind === "globals") {
        const env = parsePostmanEnvironment(text!);
        if (env.scope === "globals") out.globals.push(...env.vars.map(({ key, value }) => ({ key, value })));
        else {
          const saved = await ensureEnvironment(root, env.name, Object.fromEntries(env.vars.map((v) => [v.key, v.value])), env.vars.filter((v) => v.secret).map((v) => v.key));
          out.lastEnvId = saved.id;
          out.environments.push({ name: env.name, vars: env.vars.length, secrets: env.vars.filter((v) => v.secret).length });
        }
        if (env.skipped) out.notes.push(`${env.name}: ${env.skipped} disabled variable${env.skipped > 1 ? "s" : ""} not imported`);
      } else out.skippedFiles.push(name);
    } catch (e) {
      out.skippedFiles.push(`${name} (${(e as Error).message})`);
    }
  }
  return out;
}
