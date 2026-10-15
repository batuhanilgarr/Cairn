import fs from "node:fs";
import path from "node:path";
import { ensureEnvironment, writeImport } from "../../src/lib/importer";
import { isHar, parseHar } from "../../src/lib/har";

export type HarImportOptions = { file: string; collection: string; name?: string; includeStatic: boolean; dryRun: boolean };
export type HarImportResult = { title: string; requests: string[]; secrets: number; environment: string | null; notes: string[]; wrote: boolean };

/**
 * `cairn import har recording.har ./collection`: the same importer as the app (API calls only unless `all`, credentials
 * moved into secret variables instead of the files). Returns what was done; prints nothing that is secret.
 */
export async function importHar(o: HarImportOptions): Promise<HarImportResult> {
  const text = fs.readFileSync(o.file, "utf8");
  if (!isHar(text)) throw new Error(`${o.file} isn't a HAR recording (no log.entries).`);
  const title = o.name ?? (path.basename(o.file).replace(/\.(har|json)$/i, "") || "HAR import");
  const parsed = parseHar(text, title, { includeStatic: o.includeStatic });
  const requests = parsed.requests.map((r) => ({ ...r, folder: [title, ...r.folder] }));
  const secretNames = Object.keys(parsed.secrets ?? {});
  const names = requests.map((r) => `${r.folder.join("/")}/${r.tab.name}`);
  if (!o.dryRun && requests.length) {
    const root = path.resolve(o.collection).split(path.sep).join("/");
    await writeImport(root, requests, false);
    // tokens, passwords and keys from the recording go into an environment as secret variables, never into the files
    await ensureEnvironment(root, title, { ...parsed.vars, ...(parsed.secrets ?? {}) }, secretNames);
  }
  return { title, requests: names, secrets: secretNames.length, environment: requests.length ? title : null, notes: parsed.notes, wrote: !o.dryRun && requests.length > 0 };
}
