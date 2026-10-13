import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let Q, U, C;

async function bundle(entry) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reqnest-q-")), "m.mjs");
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"),
      "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts"),
    },
  });
  return import(out);
}

before(async () => {
  Q = await bundle("src/lib/query.ts");
  U = await bundle("src/lib/util.ts");
  C = await bundle("src/lib/collection.ts");
});

const row = (key, value, enabled = true) => ({ id: `${key}-${value}`, key, value, enabled });
const pairs = (rows) => rows.filter((r) => r.key).map((r) => [r.key, r.value, r.enabled]);

test("the URL's query becomes table rows, decoded, with disabled rows kept after them", () => {
  const rows = Q.rowsFromUrl("https://x.io/p?a=1&b=%20c%26d&flag#top", [row("keep", "me", false)]);
  assert.deepEqual(pairs(rows), [["a", "1", true], ["b", " c&d", true], ["flag", "", true], ["keep", "me", false]]);
  assert.equal(rows.at(-1).key, "", "ends with an empty row to type into");
});

test("row ids survive URL edits so inputs keep focus", () => {
  const first = Q.rowsFromUrl("https://x.io?a=1", []);
  const again = Q.rowsFromUrl("https://x.io?a=12", first);
  assert.equal(again[0].id, first[0].id);
});

test("editing the table rewrites only what changed; encoding, variables and the hash are kept", () => {
  const url = "https://x.io/p?q=EXISTS%20(%7Bx%7D)&page={{page}}&size=10#frag";
  const rows = Q.rowsFromUrl(url, []);
  assert.equal(Q.urlFromRows(url, rows), url, "no change, no rewrite");
  const edited = rows.map((r) => (r.key === "size" ? { ...r, value: "50 items" } : r));
  assert.equal(Q.urlFromRows(url, edited), "https://x.io/p?q=EXISTS%20(%7Bx%7D)&page={{page}}&size=50%20items#frag");
  const off = rows.map((r) => (r.key === "q" ? { ...r, enabled: false } : r));
  assert.equal(Q.urlFromRows(url, off), "https://x.io/p?page={{page}}&size=10#frag", "a disabled row leaves the URL");
  assert.equal(Q.urlFromRows(url, [row("only", "x y")]), "https://x.io/p?only=x%20y#frag");
  assert.equal(Q.urlFromRows(url, []), "https://x.io/p#frag");
});

test("rows that only exist in the table (older files, importers) are folded into the URL, once", () => {
  const rows = [row("a", "1"), row("b", "{{v}}"), row("off", "x", false)];
  const url = Q.foldParamsIntoUrl("https://x.io/p", rows);
  assert.equal(url, "https://x.io/p?a=1&b={{v}}");
  assert.equal(Q.foldParamsIntoUrl(url, rows), url, "idempotent");
  assert.equal(Q.foldParamsIntoUrl("https://x.io/p?z=9", [row("a", "1")]), "https://x.io/p?z=9&a=1");
});

test("sending never doubles a parameter that is both in the URL and the table, and still sends table-only rows", () => {
  const t = (url, params) => ({ ...U.newTab(), url, params });
  const both = U.buildRequest(t("https://x.io/p?a=1", [row("a", "1")]), undefined);
  assert.equal(both.url, "https://x.io/p?a=1");
  const legacy = U.buildRequest(t("https://x.io/p", [row("a", "1 2")]), undefined);
  assert.equal(legacy.url, "https://x.io/p?a=1%202");
  const off = U.buildRequest(t("https://x.io/p", [row("a", "1", false)]), undefined);
  assert.equal(off.url, "https://x.io/p");
});

test("a request file keeps the whole query in url and only switched-off rows in params; loading restores the table", () => {
  const tab = { ...U.newTab(), name: "List", method: "GET", url: "https://x.io/p?a=1", params: [row("a", "1"), row("late", "2"), row("off", "3", false)] };
  const text = C.serializeRequest(tab);
  assert.match(text, /url: https:\/\/x\.io\/p\?a=1&late=2/);
  const paramsBlock = text.split("params:")[1] ?? "";
  assert.match(paramsBlock, /off/);
  assert.doesNotMatch(paramsBlock, /key: late|key: a\b/);
  const back = C.parseRequest(text, "/tmp/list.req.yaml");
  assert.equal(back.url, "https://x.io/p?a=1&late=2");
  assert.deepEqual(pairs(back.params), [["a", "1", true], ["late", "2", true], ["off", "3", false]]);
  assert.equal(C.serializeRequest(back), text, "stable round trip");

  // an older file: params only in the table
  const legacy = C.parseRequest("name: Old\nmethod: GET\nurl: https://x.io/p\nparams:\n  - key: a\n    value: '1'\n", "/tmp/old.req.yaml");
  assert.equal(legacy.url, "https://x.io/p?a=1");
  assert.deepEqual(pairs(legacy.params), [["a", "1", true]]);
});
