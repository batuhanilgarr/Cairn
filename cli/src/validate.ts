import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { LineCounter, isMap, isNode, parseDocument } from "yaml";
import common from "../../website/schema/v1/common.schema.json";
import collection from "../../website/schema/v1/collection.schema.json";
import environment from "../../website/schema/v1/environment.schema.json";
import folder from "../../website/schema/v1/folder.schema.json";
import request from "../../website/schema/v1/request.schema.json";

/**
 * Validates collection files against the published JSON Schemas (website/schema/v1): the same files editors use
 * for completion and hover docs. Problems carry the line of the offending key.
 */
export type Kind = "request" | "folder" | "collection" | "environment";
export type Problem = { line: number; path: string; message: string };

const SCHEMAS: Record<Kind, object> = { request, folder, collection, environment };
// Compiled on first use, so only `cairn validate` pays for it (and a schema mistake can't break `cairn run`).
let compiled: Record<Kind, ReturnType<Ajv2020["compile"]>> | null = null;
function validatorFor(kind: Kind) {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    ajv.addSchema(common);
    compiled = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)])) as Record<Kind, ReturnType<Ajv2020["compile"]>>;
  }
  return compiled[kind];
}

/** Which schema a file follows, from its path relative to the collection root. */
export function kindOf(rel: string): Kind | null {
  const base = rel.split("/").pop() ?? rel;
  if (/\.req\.ya?ml$/.test(base)) return "request";
  if (/^folder\.ya?ml$/.test(base)) return "folder";
  if (/^(cairn|reqnest)\.ya?ml$/.test(base) && !rel.includes("/")) return "collection";
  if (/\.env\.ya?ml$/.test(base) && /(^|\/)environments\//.test(rel)) return "environment";
  return null;
}

const unescape = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

export function validateText(kind: Kind, text: string): Problem[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  if (doc.errors.length) return doc.errors.map((e) => ({ line: e.linePos?.[0].line ?? 1, path: "", message: `YAML syntax: ${e.message.split("\n")[0]}` }));
  const data = doc.toJS({ maxAliasCount: -1 }) ?? {};
  const validate = validatorFor(kind);
  if (validate(data)) return [];
  const lineOf = (segments: (string | number)[], key?: string): number => {
    const at = (offset: number) => lc.linePos(offset).line;
    // an unknown key: the line of that key inside the map
    if (key !== undefined) {
      const m = doc.getIn(segments, true);
      if (isMap(m)) {
        const pair = m.items.find((p) => isNode(p.key) && String((p.key as { value: unknown }).value) === key);
        if (pair && isNode(pair.key) && pair.key.range) return at(pair.key.range[0]);
      }
    }
    // otherwise: the line of the key (or list item) the path ends at, falling back to the nearest parent that exists
    for (let n = segments.length; n > 0; n--) {
      const parent = doc.getIn(segments.slice(0, n - 1), true);
      const last = segments[n - 1];
      if (isMap(parent)) {
        const pair = parent.items.find((p) => isNode(p.key) && String((p.key as { value: unknown }).value) === String(last));
        if (pair && isNode(pair.key) && pair.key.range) return at(pair.key.range[0]);
      } else if (isNode(parent) && "items" in parent && Array.isArray((parent as { items: unknown[] }).items)) {
        const item = (parent as { items: unknown[] }).items[Number(last)];
        if (isNode(item) && item.range) return at(item.range[0]);
      }
    }
    const root = doc.contents;
    return isNode(root) && root.range ? at(root.range[0]) : 1;
  };
  const out: Problem[] = [];
  for (const e of validate.errors ?? []) {
    if (e.keyword === "if") continue; // "must match else schema": the real reason is reported separately
    const segs = e.instancePath.split("/").slice(1).map(unescape).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const where = segs.join(".").replace(/\.(\d+)/g, "[$1]");
    let message = e.message ?? "is invalid";
    let key: string | undefined;
    if (e.keyword === "additionalProperties") {
      key = String(e.params.additionalProperty);
      message = `unknown key "${key}"`;
    } else if (e.keyword === "enum") message = `must be one of: ${(e.params.allowedValues as unknown[]).join(", ")}`;
    else if (e.keyword === "required") message = `missing "${e.params.missingProperty}"`;
    else if (e.keyword === "type") message = `must be ${Array.isArray(e.params.type) ? e.params.type.join(" or ") : e.params.type}`;
    const line = lineOf(segs, key);
    const dup = out.some((p) => p.line === line && p.path === (key ? [where, key].filter(Boolean).join(".") : where) && p.message === message);
    if (!dup) out.push({ line, path: key ? [where, key].filter(Boolean).join(".") : where, message });
  }
  return out.sort((a, b) => a.line - b.line);
}

const SKIP = new Set([".git", "node_modules", ".cairn", ".reqnest", "dist", "target"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ya?ml$/i.test(e.name)) out.push(p);
  }
  return out;
}

export type FileProblems = { file: string; kind: Kind; problems: Problem[] };

/** Validate every collection file under a folder. Files that aren't collection files are ignored. */
export function validateDirectory(root: string): { checked: number; failures: FileProblems[] } {
  const abs = path.resolve(root);
  let checked = 0;
  const failures: FileProblems[] = [];
  for (const file of walk(abs).sort()) {
    const rel = path.relative(abs, file).split(path.sep).join("/");
    const kind = kindOf(rel);
    if (!kind) continue;
    checked++;
    const problems = validateText(kind, fs.readFileSync(file, "utf8"));
    if (problems.length) failures.push({ file: rel, kind, problems });
  }
  return { checked, failures };
}
