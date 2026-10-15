import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");
let X;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ox-")), "m.mjs");
  await build({
    stdin: {
      contents: `export * from "./src/lib/openapiExport.ts"; export * from "./src/lib/util.ts"; export { parseOpenApi } from "./src/lib/openapi.ts"; export * from "./src/lib/secrets.ts";`,
      resolveDir: ROOT,
    },
    outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"),
      "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts"),
    },
  });
  X = await import(out);
});

const kv = (key, value, extra = {}) => ({ id: key, key, value, enabled: true, secret: false, ...extra });
const req = (over) => ({ ...X.newTab(), ...over });
const item = (over, folder = []) => ({ tab: req(over), folder, file: "/c/x.req.yaml" });

/** What a spec must satisfy to be usable by the OpenAPI tools: checked structurally. */
function check(doc) {
  const problems = [];
  if (doc.openapi !== "3.0.3") problems.push("openapi version");
  if (!doc.info?.title || !doc.info?.version) problems.push("info");
  const ids = new Set();
  for (const [p, ops] of Object.entries(doc.paths)) {
    if (!p.startsWith("/")) problems.push(`path ${p} must start with /`);
    for (const [m, op] of Object.entries(ops)) {
      if (!op.responses || !Object.keys(op.responses).length) problems.push(`${m} ${p}: no responses`);
      if (ids.has(op.operationId)) problems.push(`duplicate operationId ${op.operationId}`);
      ids.add(op.operationId);
      const declared = new Set((op.parameters ?? []).filter((x) => x.in === "path").map((x) => x.name));
      for (const [, name] of p.matchAll(/\{([^}]+)\}/g)) if (!declared.has(name) && !(doc.servers ?? []).length) problems.push(`${m} ${p}: {${name}} not declared`);
      for (const x of op.parameters ?? []) if (x.in === "path" && x.required !== true) problems.push(`${m} ${p}: path parameter ${x.name} must be required`);
      const seen = new Set();
      for (const x of op.parameters ?? []) { const k = x.in + x.name; if (seen.has(k)) problems.push(`${m} ${p}: duplicate parameter ${k}`); seen.add(k); }
      for (const s of op.security ?? []) for (const n of Object.keys(s)) if (!doc.components?.securitySchemes?.[n]) problems.push(`${m} ${p}: unknown security scheme ${n}`);
    }
  }
  return problems;
}

test("a request becomes an operation: path, query, headers, tags, operationId", () => {
  const { doc, operations } = X.buildOpenApi([
    item({ name: "List invoices", method: "GET", url: "{{baseUrl}}/v1/invoices?limit=10&status=open", params: [kv("expand", "customer")], headers: [kv("X-Trace", "abc"), kv("Accept", "application/json")] }, ["billing", "invoices"]),
  ], { title: "Payments", vars: { baseUrl: "https://api.example.com/" } });
  assert.equal(operations, 1);
  assert.deepEqual(check(doc), []);
  assert.deepEqual(doc.servers, [{ url: "https://api.example.com" }]);
  const op = doc.paths["/v1/invoices"].get;
  assert.equal(op.summary, "List invoices");
  assert.equal(op.operationId, "listInvoices");
  assert.deepEqual(op.tags, ["billing / invoices"]);
  assert.deepEqual(op.parameters.map((p) => [p.in, p.name, p.example]), [["query", "limit", "10"], ["query", "status", "open"], ["query", "expand", "customer"], ["header", "X-Trace", "abc"]]);
  assert.equal(op.parameters[0].schema.type, "integer");
  assert.deepEqual(doc.tags, [{ name: "billing / invoices" }]);
});

test("an unresolved {{baseUrl}} becomes a server variable; path variables become required path parameters", () => {
  const { doc } = X.buildOpenApi([
    item({ name: "Get invoice", method: "GET", url: "{{baseUrl}}/v1/invoices/{{invoiceId}}/lines/:line" }),
  ], { title: "T" });
  assert.deepEqual(check(doc), []);
  assert.equal(doc.servers[0].url, "{baseUrl}");
  assert.ok(doc.servers[0].variables.baseUrl.default);
  const op = doc.paths["/v1/invoices/{invoiceId}/lines/{line}"].get;
  assert.deepEqual(op.parameters.map((p) => [p.name, p.in, p.required]), [["invoiceId", "path", true], ["line", "path", true]]);
});

test("json, form, multipart, text and graphql bodies", () => {
  const { doc, notes } = X.buildOpenApi([
    item({ name: "Create", method: "POST", url: "https://x.io/a", bodyMode: "json", body: '{"customer": "{{customerId}}", "amount": 12900, "items": [{"sku": "a", "qty": 2}], "paid": false}' }),
    item({ name: "Unquoted var", method: "POST", url: "https://x.io/b", bodyMode: "json", body: '{"n": {{count}}}' }),
    item({ name: "Form", method: "POST", url: "https://x.io/c", bodyMode: "form", body: "a=1&b=two" }),
    item({ name: "Upload", method: "POST", url: "https://x.io/d", bodyMode: "multipart", formParts: [{ id: "1", key: "title", value: "t", enabled: true, kind: "text" }, { id: "2", key: "file", value: "/tmp/f", enabled: true, kind: "file" }] }),
    item({ name: "Text", method: "PUT", url: "https://x.io/e", bodyMode: "text", body: "hello" }),
    item({ name: "Query", kind: "graphql", url: "https://x.io/graphql", gql: { query: "{ me { id } }", variables: '{"id": 1}', operation: "Me" } }),
    item({ name: "Broken", method: "POST", url: "https://x.io/f", bodyMode: "json", body: "{nope" }),
  ], { title: "T" });
  assert.deepEqual(check(doc), []);
  const s = doc.paths["/a"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(s.properties.amount, { type: "integer" });
  assert.deepEqual(s.properties.items, { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } } } });
  assert.deepEqual(s.properties.paid, { type: "boolean" });
  assert.ok(doc.paths["/b"].post.requestBody.content["application/json"].example, "an unquoted {{variable}} still yields an example");
  assert.deepEqual(Object.keys(doc.paths["/c"].post.requestBody.content), ["application/x-www-form-urlencoded"]);
  assert.deepEqual(doc.paths["/d"].post.requestBody.content["multipart/form-data"].schema.properties.file, { type: "string", format: "binary" });
  assert.equal(doc.paths["/e"].put.requestBody.content["text/plain"].example, "hello");
  const g = doc.paths["/graphql"].post.requestBody.content["application/json"].example;
  assert.deepEqual([g.query, g.variables, g.operationName], ["{ me { id } }", { id: 1 }, "Me"]);
  assert.ok(notes.some((n) => /"Broken".*syntax error/.test(n)));
});

test("auth becomes security schemes; the values are never written", () => {
  const { doc } = X.buildOpenApi([
    item({ name: "A", method: "GET", url: "https://x.io/a", authMode: "bearer", authToken: "live-token-value-123456" }),
    item({ name: "B", method: "GET", url: "https://x.io/b", authMode: "basic", authUser: "ada", authPass: "hunter2hunter2" }),
    item({ name: "C", method: "GET", url: "https://x.io/c", headers: [kv("X-Api-Key", "k-1234567890abcdef")] }),
    item({ name: "D", method: "GET", url: "https://x.io/d?api_key=abcdef1234567890" }),
    item({ name: "E", method: "GET", url: "https://x.io/e", authMode: "oauth2", oauth: { ...X.defaultOAuth(), grant: "client_credentials", tokenUrl: "https://auth.x.io/token", scope: "read write", clientSecret: "shhh-very-secret" } }),
  ], { title: "T" });
  assert.deepEqual(check(doc), []);
  const sc = doc.components.securitySchemes;
  assert.deepEqual(sc.bearerAuth, { type: "http", scheme: "bearer" });
  assert.deepEqual(sc.basicAuth, { type: "http", scheme: "basic" });
  assert.deepEqual(sc.apiKeyXApiKey, { type: "apiKey", in: "header", name: "X-Api-Key" });
  assert.deepEqual(sc.oauth2.flows.clientCredentials, { tokenUrl: "https://auth.x.io/token", scopes: { read: "", write: "" } });
  assert.deepEqual(doc.paths["/e"].get.security, [{ oauth2: ["read", "write"] }]);
  assert.ok(Object.values(sc).some((s) => s.in === "query" && s.name === "api_key"));
  const text = JSON.stringify(doc);
  for (const secret of ["live-token-value-123456", "hunter2hunter2", "k-1234567890abcdef", "abcdef1234567890", "shhh-very-secret", "ada"]) assert.ok(!text.includes(secret), `the spec must not contain ${secret}`);
});

test("saved examples become responses; secrets inside them are redacted; tests give the expected status", () => {
  const ex = (status, body, ct = "application/json") => ({ id: String(status), name: status === 200 ? "OK" : "Not found", status, headers: [kv("Content-Type", ct)], body, delayMs: 0 });
  const { doc, notes } = X.buildOpenApi([
    item({ name: "Login", method: "POST", url: "https://x.io/login", examples: [ex(200, '{"user": {"id": 7, "name": "Ada"}, "access_token": "abc.def.ghi-live-value", "refresh": "r-12345678"}'), ex(404, '{"error": "nope"}'), ex(500, "boom happened", "text/plain")] }),
    item({ name: "Tests only", method: "GET", url: "https://x.io/t", assertions: [{ id: "1", enabled: true, kind: "status", path: "", op: "eq", value: "201" }] }),
    item({ name: "Nothing", method: "GET", url: "https://x.io/n" }),
  ], { title: "T" });
  assert.deepEqual(check(doc), []);
  const r = doc.paths["/login"].post.responses;
  assert.deepEqual(Object.keys(r), ["200", "404", "500"]);
  assert.equal(r["200"].content["application/json"].example.access_token, "<redacted>");
  assert.equal(r["200"].content["application/json"].example.user.name, "Ada");
  assert.deepEqual(r["200"].content["application/json"].schema.properties.user, { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } });
  assert.equal(r["500"].content["text/plain"].example, "boom happened");
  assert.deepEqual(Object.keys(doc.paths["/t"].get.responses), ["201"]);
  assert.deepEqual(Object.keys(doc.paths["/n"].get.responses), ["default"]);
  assert.ok(!JSON.stringify(doc).includes("abc.def.ghi-live-value"));
  assert.equal(notes.length, 0, notes.join("; "));
});

test("skips what OpenAPI can't describe, keeps the first of duplicates, makes operation ids unique", () => {
  const { doc, notes, operations } = X.buildOpenApi([
    item({ name: "Socket", kind: "ws", url: "wss://x.io/s" }),
    item({ name: "Same", method: "GET", url: "https://x.io/same" }),
    item({ name: "Same", method: "GET", url: "https://x.io/same" }),
    item({ name: "Same", method: "POST", url: "https://x.io/same" }),
    item({ name: "No url", method: "GET", url: "" }),
  ], { title: "T" });
  assert.equal(operations, 2);
  assert.deepEqual(check(doc), []);
  assert.ok(notes.some((n) => /Socket.*ws/.test(n)));
  assert.ok(notes.some((n) => /shares GET \/same/.test(n)));
  assert.ok(notes.some((n) => /No url.*no URL/.test(n)));
  assert.notEqual(doc.paths["/same"].get.operationId, doc.paths["/same"].post.operationId);
});

test("several servers: the first is global, others are set on the operations that use them", () => {
  const { doc } = X.buildOpenApi([
    item({ name: "A", method: "GET", url: "https://a.io/x" }),
    item({ name: "B", method: "GET", url: "https://b.io/y" }),
  ], { title: "T" });
  assert.deepEqual(doc.servers.map((s) => s.url), ["https://a.io", "https://b.io"]);
  assert.equal(doc.paths["/x"].get.servers, undefined);
  assert.deepEqual(doc.paths["/y"].get.servers, [{ url: "https://b.io" }]);
});

test("round trip: the exported spec imports back into the same requests", () => {
  const { doc } = X.buildOpenApi([
    item({ name: "List", method: "GET", url: "https://api.x.io/v1/items?limit=5" }, ["items"]),
    item({ name: "Create", method: "POST", url: "https://api.x.io/v1/items", bodyMode: "json", body: '{"name": "x"}' }, ["items"]),
    item({ name: "Get", method: "GET", url: "https://api.x.io/v1/items/{{id}}" }, ["items"]),
  ], { title: "Items" });
  for (const text of [X.toYaml(doc), X.toJson(doc)]) {
    assert.deepEqual(parse(text), doc, "serialising must not change the document");
    const back = X.parseOpenApi(text);
    assert.equal(back.title, "Items");
    assert.deepEqual(back.requests.map((r) => r.tab.method).sort(), ["GET", "GET", "POST"]);
    assert.ok(back.requests.some((r) => /\/v1\/items\/\{\{id\}\}$/.test(r.tab.url)), "path parameter survives as a variable");
    assert.ok(back.requests.some((r) => r.tab.method === "POST" && /"name"/.test(r.tab.body)));
  }
});

import { execFile } from "node:child_process";
const CLI = path.join(ROOT, "cli/dist/cairn.mjs");
const sh = (args, cwd) => new Promise((resolve) => execFile("node", [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("CLI: cairn export openapi reads a collection with folder defaults, links and environments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-export-"));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w("cairn.yaml", "name: Payments\n");
  w("folder.yaml", "auth:\n  mode: bearer\n  token: '{{token}}'\nheaders:\n  - key: X-Team\n    value: core\n");
  w("environments/prod.env.yaml", "name: Prod\nvars:\n  - key: baseUrl\n    value: https://api.pay.example.com\n  - key: token\n    value: ''\n    secret: true\n");
  w("invoices/list.req.yaml", "name: List invoices\nmethod: GET\nurl: '{{baseUrl}}/v1/invoices'\nauth:\n  mode: inherit\nexamples:\n  - id: e1\n    name: OK\n    status: 200\n    headers:\n      - key: Content-Type\n        value: application/json\n    body: '{\"data\": []}'\n");
  w("shared/ping.req.yaml", "name: Ping\nmethod: GET\nurl: '{{baseUrl}}/ping'\n");
  w("invoices/ping.req.yaml", "use: ../shared/ping.req.yaml\n");
  w("streams/ws.req.yaml", "name: Live\ntype: ws\nurl: wss://x.io/ws\n");
  const r = await sh(["export", "openapi", dir, "--env", "Prod"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = parse(r.stdout);
  assert.equal(doc.info.title, "Payments");
  assert.deepEqual(doc.servers, [{ url: "https://api.pay.example.com" }]);
  const list = doc.paths["/v1/invoices"].get;
  assert.deepEqual(list.tags, ["invoices"]);
  assert.deepEqual(list.security, [{ bearerAuth: [] }], "auth inherited from folder.yaml");
  assert.ok(list.parameters.some((p) => p.name === "X-Team"), "inherited header");
  assert.ok(doc.paths["/ping"], "a linked request is exported");
  assert.match(r.stderr, /operations exported/);
  assert.match(r.stderr, /Live.*ws/);
  assert.ok(!r.stdout.includes("{{token}}"));
  const out = path.join(dir, "api.json");
  const j = await sh(["export", "openapi", dir, "-o", out, "--env", "Prod"]);
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).openapi, "3.0.3");
  const sub = parse((await sh(["export", "openapi", path.join(dir, "invoices"), "--env", "Prod"])).stdout);
  assert.deepEqual(Object.keys(sub.paths).sort(), ["/ping", "/v1/invoices"], "exporting a folder exports only its requests");
  assert.notEqual((await sh(["export", "openapi", dir, "--format", "xml"])).code, 0);
  assert.notEqual((await sh(["export", "swagger", dir])).code, 0);
});
