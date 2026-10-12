import type { AuthMode, BodyMode, KV } from "./types";
import { emptyKV, newTab } from "./util";
import type { ImportedRequest } from "./openapi";

type Blocks = Record<string, string[]>;

/** Split a .bru file into `name { ... }` blocks (content de-indented by two spaces). */
export function parseBlocks(text: string): Blocks {
  const out: Blocks = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w:\-]+)\s*\{\s*$/);
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && lines[i] !== "}"; i++) body.push(lines[i].replace(/^ {2}/, ""));
    out[m[1]] = body;
  }
  return out;
}

const kv = (lines?: string[]): KV[] => [
  ...(lines ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const off = l.startsWith("~");
      const s = off ? l.slice(1) : l;
      const i = s.indexOf(":");
      return { ...emptyKV(), key: (i === -1 ? s : s.slice(0, i)).trim(), value: i === -1 ? "" : s.slice(i + 1).trim(), enabled: !off };
    }),
  emptyKV(),
];

const field = (lines: string[] | undefined, name: string) => {
  const l = lines?.find((x) => x.trim().startsWith(name + ":"));
  return l ? l.slice(l.indexOf(":") + 1).trim() : "";
};

export function parseBru(text: string, folder: string[], fileName: string): { req: ImportedRequest; notes: string[] } | null {
  const b = parseBlocks(text);
  const method = ["get", "post", "put", "patch", "delete", "head", "options"].find((m) => b[m]);
  if (!method) return null; // folder.bru, collection.bru, environments, ...
  const notes: string[] = [];
  const t = newTab();
  t.name = field(b.meta, "name") || fileName.replace(/\.bru$/, "");
  t.method = method.toUpperCase();
  t.url = field(b[method], "url");
  t.headers = kv(b.headers);
  t.params = kv(b["params:query"]);

  const mode = field(b[method], "body");
  let bm: BodyMode = "none";
  if (mode === "json" && b["body:json"]) {
    bm = "json";
    t.body = b["body:json"].join("\n");
  } else if (mode === "text" && b["body:text"]) {
    bm = "text";
    t.body = b["body:text"].join("\n");
  } else if (mode === "formUrlEncoded" && b["body:form-urlencoded"]) {
    bm = "form";
    t.body = b["body:form-urlencoded"]
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("~"))
      .map((l) => {
        const i = l.indexOf(":");
        return `${encodeURIComponent(l.slice(0, i).trim())}=${encodeURIComponent(l.slice(i + 1).trim())}`;
      })
      .join("&");
  } else if (mode && mode !== "none") notes.push(`"${t.name}": ${mode} body isn't supported yet, left empty`);
  t.bodyMode = bm;

  let am: AuthMode = "none";
  if (b["auth:bearer"]) {
    am = "bearer";
    t.authToken = field(b["auth:bearer"], "token");
  } else if (b["auth:basic"]) {
    am = "basic";
    t.authUser = field(b["auth:basic"], "username");
    t.authPass = field(b["auth:basic"], "password");
  } else if (Object.keys(b).some((k) => k.startsWith("auth:"))) notes.push(`"${t.name}": ${Object.keys(b).find((k) => k.startsWith("auth:"))} isn't supported yet`);
  t.authMode = am;
  return { req: { folder, base: t.name, tab: t }, notes };
}

/** `environments/*.bru`: `vars { k: v }` plus `vars:secret [ names ]`. */
export function parseBruEnv(text: string): { vars: { key: string; value: string; secret: boolean }[] } {
  const b = parseBlocks(text);
  const secrets = new Set(
    (text.match(/vars:secret\s*\[([\s\S]*?)\]/)?.[1] ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
  );
  const vars = (b.vars ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      const key = l.slice(0, i).trim();
      return { key, value: l.slice(i + 1).trim(), secret: false };
    });
  for (const s of secrets) vars.push({ key: s, value: "", secret: true });
  return { vars };
}
