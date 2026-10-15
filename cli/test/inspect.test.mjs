import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let O;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-insp-")), "m.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/openapi.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  O = await import(out);
});

const oas3 = (extra = {}) => JSON.stringify({ openapi: "3.0.3", info: { title: "Pets", version: "1" }, servers: [{ url: "https://pets.example" }], paths: { "/pets": { get: { summary: "List pets", responses: { 200: { description: "ok" } } }, post: { summary: "Add pet", responses: { 201: { description: "ok" } } } }, "/pets/{id}": { delete: { responses: { 204: { description: "gone" } } } } }, ...extra });

test("a pasted OpenAPI 3 document (JSON) is recognised, counted and previewed", () => {
  const i = O.inspectSpec(oas3());
  assert.equal(i.kind, "spec");
  assert.equal(i.title, "Pets");
  assert.equal(i.version, "3.0.3");
  assert.equal(i.requests, 3);
  assert.deepEqual(i.names, ["GET /pets", "POST /pets", "DELETE /pets/{id}"]);
});

test("YAML and Swagger 2 work the same way, and surrounding whitespace is ignored", () => {
  const yaml = `\n\n  \nopenapi: 3.0.0\ninfo:\n  title: Y\n  version: '1'\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok}\n`;
  assert.equal(O.inspectSpec(yaml).requests, 1);
  const v2 = JSON.stringify({ swagger: "2.0", info: { title: "Old", version: "1" }, host: "old.example", paths: { "/x": { get: { responses: { 200: { description: "ok" } } } } } });
  const i = O.inspectSpec(v2);
  assert.equal(i.kind, "spec");
  assert.equal(i.version, "Swagger 2.0");
});

test("a link to a spec is recognised as a link (the app downloads it)", () => {
  assert.deepEqual(O.inspectSpec("  https://petstore3.swagger.io/api/v3/openapi.json \n"), { kind: "url", url: "https://petstore3.swagger.io/api/v3/openapi.json" });
  assert.equal(O.inspectSpec("https://a.b/c d").kind, "other", "text that merely starts with a URL is not a link");
});

test("things that are not an OpenAPI document say what they are, instead of failing later", () => {
  const why = (t) => { const i = O.inspectSpec(t); assert.equal(i.kind, "other", t.slice(0, 40)); return i.reason; };
  assert.equal(O.inspectSpec("").kind, "empty");
  assert.equal(O.inspectSpec("  \n ").kind, "empty");
  assert.match(why(JSON.stringify({ info: { name: "c" }, item: [] })), /Postman collection/);
  assert.match(why(JSON.stringify({ log: { entries: [] } })), /HAR recording/);
  assert.match(why("just some words"), /isn't an OpenAPI/);
  assert.match(why("{ not: valid: yaml: ["), /Not valid JSON or YAML/);
  assert.match(why(JSON.stringify({ info: {}, paths: {} })), /Missing the openapi/);
  assert.match(why(JSON.stringify({ openapi: "3.0.0", info: {} })), /no paths/);
  assert.match(why(JSON.stringify({ openapi: "3.0.0", info: { title: "e", version: "1" }, paths: { "/x": {} } })), /no operations/);
  assert.match(why("[1, 2]"), /isn't an OpenAPI/);
  assert.match(why("x".repeat(3_100_000)), /Too large to preview/);
});

test("the preview matches what the importer would write", () => {
  const text = oas3();
  assert.equal(O.inspectSpec(text).requests, O.parseOpenApi(text).requests.length);
});
