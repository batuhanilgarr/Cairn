import type { Environment, RequestTab } from "./types";
import type { ImportedRequest } from "./openapi";
import { mergeSpecInto } from "./openapi";
import { emptyKV, uid } from "./util";
import { join, listFilesRecursive, readText, writeText } from "./fs";
import { loadEnvironments, parseRequest, saveEnvironment, serializeRequest, slug, uniquePath } from "./collection";

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
