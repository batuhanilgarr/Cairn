import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let V, L;

async function bundle(contents) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sch-")), "m.mjs");
  await build({
    stdin: { contents, resolveDir: ROOT }, outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
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
  V = await bundle(`export * from "./cli/src/validate.ts";`);
  L = await bundle(`export * from "./src/lib/collection.ts"; export * from "./src/lib/util.ts"; export { parseOpenApi } from "./src/lib/openapi.ts"; export { parseHar } from "./src/lib/har.ts"; export { buildOpenApi } from "./src/lib/openapiExport.ts";`);
});

const kv = (key, value, extra = {}) => ({ id: key, key, value, enabled: true, ...extra });
const tab = (over) => ({ ...L.newTab(), ...over });
const problems = (kind, text) => V.validateText(kind, text);
const ok = (kind, text, why) => assert.deepEqual(problems(kind, text), [], `${why ?? kind}:\n${text}`);

/** Every kind of request Cairn can write: the schema must accept all of them. */
const CORPUS = () => {
  const oauth = L.defaultOAuth();
  return {
    "plain get": tab({ name: "List", method: "GET", url: "{{baseUrl}}/v1/items?limit=10" }),
    "all methods": tab({ name: "Patch", method: "PATCH", url: "https://x.io/p" }),
    "disabled rows": tab({ url: "https://x.io", headers: [kv("X-A", "1", { enabled: false }), kv("X-B", "2")], params: [kv("q", "z", { enabled: false })] }),
    "json body": tab({ method: "POST", url: "https://x.io", bodyMode: "json", body: '{\n  "a": 1\n}' }),
    "form body": tab({ method: "POST", url: "https://x.io", bodyMode: "form", body: "a=1&b=2" }),
    "text body": tab({ method: "POST", url: "https://x.io", bodyMode: "text", body: "hello\nworld" }),
    "binary body": tab({ method: "POST", url: "https://x.io", bodyMode: "binary", body: "/tmp/file.bin" }),
    "multipart": tab({ method: "POST", url: "https://x.io", bodyMode: "multipart", formParts: [{ id: "1", key: "t", value: "x", enabled: true, kind: "text" }, { id: "2", key: "f", value: "/tmp/a.pdf", enabled: false, kind: "file", contentType: "application/pdf" }] }),
    "bearer": tab({ url: "https://x.io", authMode: "bearer", authToken: "{{token}}" }),
    "basic": tab({ url: "https://x.io", authMode: "basic", authUser: "ada", authPass: "{{pw}}" }),
    "inherit": tab({ url: "https://x.io", authMode: "inherit" }),
    "oauth cc": tab({ url: "https://x.io", authMode: "oauth2", oauth: { ...oauth, grant: "client_credentials", tokenUrl: "https://a/t", clientId: "c", clientSecret: "{{s}}", scope: "r w" } }),
    "oauth code": tab({ url: "https://x.io", authMode: "oauth2", oauth: { ...oauth, grant: "authorization_code", authUrl: "https://a/auth", tokenUrl: "https://a/t", clientId: "c", pkce: false, redirectPort: 9000, clientAuth: "body", prefix: "Token", extra: [kv("audience", "api")] } }),
    "oauth password": tab({ url: "https://x.io", authMode: "oauth2", oauth: { ...oauth, grant: "password", tokenUrl: "https://a/t", clientId: "c", username: "u", password: "{{p}}" } }),
    "graphql": tab({ kind: "graphql", name: "Me", url: "https://x.io/graphql", gql: { query: "{ me { id } }", variables: '{"a":1}', operation: "Me" } }),
    "websocket": tab({ kind: "ws", url: "wss://x.io", ws: { composer: "ping", protocols: "chat", messages: [{ id: "1", name: "hello", body: "hi" }] } }),
    "sse": tab({ kind: "sse", url: "https://x.io/events" }),
    "mcp http": tab({ kind: "mcp", url: "https://x.io/mcp", mcp: { transport: "http", command: "", args: "", env: [] } }),
    "mcp stdio": tab({ kind: "mcp", url: "", mcp: { transport: "stdio", command: "npx", args: "-y server", env: [kv("TOKEN", "{{t}}")] } }),
    "socket.io": tab({ kind: "sio", url: "https://x.io", sio: { namespace: "/chat", path: "/rt/", auth: '{"token":"t"}', event: "message", composer: '[{"a":1}]', ack: true, messages: [{ id: "1", name: "Join", event: "join", body: '["lobby"]' }] } }),
    "socket.io (minimal)": tab({ kind: "sio", url: "https://x.io", sio: { namespace: "", path: "", auth: "", event: "", composer: "", ack: false, messages: [] } }),
    "mqtt": tab({ kind: "mqtt", url: "mqtts://b.io", authMode: "basic", authUser: "ada", authPass: "{{pw}}", mqtt: { clientId: "c1", keepAlive: 30, clean: false, willTopic: "st/x", willPayload: "off", willQos: 1, willRetain: true, topic: "a/b", payload: '{"x":1}', qos: 2, retain: true, format: "json", subs: [{ id: "1", topic: "a/#", qos: 0 }, { id: "2", topic: "b/+", qos: 2 }] } }),
    "mqtt (minimal)": tab({ kind: "mqtt", url: "mqtt://b.io", mqtt: { clientId: "", keepAlive: 60, clean: true, willTopic: "", willPayload: "", willQos: 0, willRetain: false, topic: "", payload: "", qos: 0, retain: false, format: "text", subs: [] } }),
    "grpc reflection": tab({ kind: "grpc", url: "x.io:443", grpc: { source: "reflection", protoFiles: [], importPaths: [], method: "a.B/C", message: "{}", tls: false } }),
    "grpc proto": tab({ kind: "grpc", url: "x.io:443", grpc: { source: "proto", protoFiles: ["a.proto"], importPaths: ["."], method: "a.B/C", message: '{"x":1}', tls: true } }),
    "examples": tab({ url: "https://x.io", examples: [{ id: "1", name: "OK", status: 200, headers: [kv("Content-Type", "application/json")], body: '{"ok":true}', delayMs: 250 }, { id: "2", name: "Empty", status: 204, headers: [], body: "", delayMs: 0 }] }),
    "tests and captures": tab({ url: "https://x.io", assertions: [{ id: "1", enabled: true, kind: "status", path: "", op: "eq", value: "200" }, { id: "2", enabled: false, kind: "json", path: "$.id", op: "exists", value: "" }, { id: "3", enabled: true, kind: "time", path: "", op: "lt", value: "500" }], captures: [{ id: "1", variable: "id", from: "json", path: "$.id" }, { id: "2", variable: "etag", from: "header", path: "ETag" }] }),
    "scripts": tab({ url: "https://x.io", preScript: "pm.variables.set('a', 1)", postScript: "pm.test('ok', () => {})" }),
    "settings": tab({ url: "https://x.io", followRedirects: false, insecure: true, timeoutMs: 5000 }),
    "source": tab({ url: "https://x.io", source: "openapi:GET /items" }),
  };
};

test("every request Cairn can write follows the schema", () => {
  for (const [name, t] of Object.entries(CORPUS())) ok("request", L.serializeRequest(t), name);
});

test("link files, folder defaults, collection and environment files follow their schemas", async () => {
  ok("request", "use: ../shared/login.req.yaml\n", "link");
  const defaults = tab({ vars: [kv("team", "core")], headers: [kv("X-Team", "{{team}}"), kv("X-Off", "1", { enabled: false })], authMode: "bearer", authToken: "{{t}}", preScript: "a()", postScript: "b()" });
  ok("folder", L.serializeDefaults(defaults), "folder defaults");
  ok("collection", "name: Payments\n", "collection");
  ok("collection", "name: Payments\nopenapi:\n  source: https://x.io/openapi.json\n", "collection with openapi");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-env-schema-"));
  fs.mkdirSync(path.join(dir, "environments"));
  const file = await L.saveEnvironment(dir, { id: "e", name: "Staging", extends: "Base", vars: [kv("baseUrl", "https://s"), kv("token", "T", { secret: true }), kv("off", "x", { enabled: false })] });
  ok("environment", fs.readFileSync(file, "utf8"), "environment");
});

test("what the importers produce follows the schema too (OpenAPI, HAR)", () => {
  const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "T", version: "1" }, servers: [{ url: "https://api.x.io" }], paths: { "/items/{id}": { get: { summary: "Get", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "q", in: "query", schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { example: { a: 1 } } } } } }, put: { summary: "Put", requestBody: { content: { "application/json": { example: { b: 2 } } } }, responses: { 200: { description: "ok" } } } } } });
  const oas = L.parseOpenApi(spec);
  assert.ok(oas.requests.length >= 2);
  for (const r of oas.requests) ok("request", L.serializeRequest(r.tab), `openapi: ${r.tab.name}`);
  const har = JSON.stringify({ log: { entries: [{ startedDateTime: "2026-01-01T00:00:00Z", _resourceType: "xhr", request: { method: "POST", url: "https://api.x.io/v1/a", headers: [{ name: "Authorization", value: "Bearer abcdefghijklmnopqrstuvwxyz" }, { name: "X-A", value: "1" }], postData: { mimeType: "application/json", text: '{"a":1,"password":"correct-horse-battery"}' } }, response: { status: 200, content: { mimeType: "application/json", text: '{"ok":true}' } } }] } });
  for (const r of L.parseHar(har, "rec").requests) ok("request", L.serializeRequest(r.tab), `har: ${r.tab.name}`);
});

test("the files in this repository's fixtures follow the schemas", () => {
  const { checked, failures } = V.validateDirectory(path.join(ROOT, "tests/fixtures/openapi-collection"));
  assert.ok(checked >= 10, `only ${checked} files checked`);
  assert.deepEqual(failures.map((f) => [f.file, f.problems]), []);
});

test("mistakes are found, with the line and what is wrong", () => {
  const bad = (kind, text, re, line) => {
    const p = problems(kind, text);
    assert.ok(p.length > 0, `should be rejected:\n${text}`);
    const hit = p.find((x) => re.test(x.message) || re.test(x.path));
    assert.ok(hit, `expected ${re}, got ${JSON.stringify(p)}`);
    if (line) assert.equal(hit.line, line, `line of "${hit.message}"`);
    return p;
  };
  bad("request", "name: A\nmethod: GET\nurl: https://x\nbogus: 1\n", /unknown key "bogus"/, 4);
  bad("request", "name: A\nmethod: GET\nurl: https://x\nauth:\n  mode: magic\n", /must be one of: none, inherit, bearer/, 5);
  bad("request", "name: A\nurl: https://x\nauth:\n  token: abc\n", /missing "mode"/, 3);
  bad("request", "name: A\nurl: https://x\nheaders:\n  - key: A\n    valeu: 1\n", /unknown key "valeu"/, 5);
  bad("request", "name: A\nurl: https://x\ntests:\n  - kind: status\n    op: equals\n    value: 200\n", /must be one of: eq/, 5);
  bad("request", "name: A\nurl: https://x\nexamples:\n  - name: x\n    status: 99\n", /minimum|>=|must be/, 5);
  bad("request", "name: A\nurl: https://x\nsettings:\n  timeoutMs: soon\n", /must be integer/, 4);
  bad("request", "name: A\ntype: carrier-pigeon\nurl: x\n", /must be one of: graphql/, 2);
  bad("request", "use: ../x.req.yaml\nname: nope\n", /unknown key "name"/, 2);
  bad("request", "name: A\nurl: [1, 2]\n", /must be string/, 2);
  bad("environment", "name: E\nvars:\n  - key: a\n    value: b\n    secret: yes please\n", /must be boolean/, 5);
  bad("environment", "name: E\nvariables: []\n", /unknown key "variables"/, 2);
  bad("folder", "headers:\n  - key: A\nauth:\n  mode: bearer\n  tokn: x\n", /unknown key "tokn"/, 5);
  bad("collection", "title: x\n", /unknown key "title"/, 1);
  const syntax = problems("request", "name: [unclosed\n");
  assert.match(syntax[0].message, /YAML syntax/);
});

test("which file follows which schema", () => {
  assert.equal(V.kindOf("a/b/list.req.yaml"), "request");
  assert.equal(V.kindOf("folder.yaml"), "folder");
  assert.equal(V.kindOf("billing/folder.yaml"), "folder");
  assert.equal(V.kindOf("cairn.yaml"), "collection");
  assert.equal(V.kindOf("reqnest.yaml"), "collection");
  assert.equal(V.kindOf("sub/cairn.yaml"), null, "only the root file is the collection file");
  assert.equal(V.kindOf("environments/prod.env.yaml"), "environment");
  assert.equal(V.kindOf("other/prod.env.yaml"), null);
  assert.equal(V.kindOf("docker-compose.yaml"), null);
  assert.equal(V.kindOf(".github/workflows/ci.yml"), null);
});

test("the published schemas are well-formed JSON Schema, each with a versioned $id", () => {
  const dir = path.join(ROOT, "website/schema/v1");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["collection.schema.json", "common.schema.json", "environment.schema.json", "folder.schema.json", "request.schema.json"]);
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(s.$id, new RegExp(`/schema/v1/${f.replace(".", "\\.")}$`));
    assert.ok(s.title && (s.description || f === "common.schema.json"), `${f} needs a title and description (editors show them)`);
  }
});

const CLI = path.join(ROOT, "cli/dist/cairn.mjs");
const run = (args) => new Promise((resolve) => execFile("node", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("CLI: cairn validate passes a good collection and reports file:line for a bad one", async () => {
  const good = await run(["validate", path.join(ROOT, "tests/fixtures/openapi-collection")]);
  assert.equal(good.code, 0, good.stdout);
  assert.match(good.stdout, /follow the format \(schema v1\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-validate-"));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: T\n");
  fs.mkdirSync(path.join(dir, "environments"));
  fs.writeFileSync(path.join(dir, "environments/dev.env.yaml"), "name: Dev\nvars:\n  - key: a\n    value: b\n    secrte: true\n");
  fs.writeFileSync(path.join(dir, "ok.req.yaml"), "name: ok\nmethod: GET\nurl: https://x\n");
  fs.writeFileSync(path.join(dir, "bad.req.yaml"), "name: bad\nmethod: GET\nurl: https://x\nauth:\n  mode: nope\n");
  fs.writeFileSync(path.join(dir, "notes.yaml"), "anything: goes\n");
  const r = await run(["validate", dir]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /bad\.req\.yaml:5\s+auth\.mode\s+must be one of/);
  assert.match(r.stdout, /environments\/dev\.env\.yaml:5\s+vars\[0\]\.secrte\s+unknown key "secrte"/);
  assert.match(r.stdout, /2 problems in 2 of 4 files/);
  const j = JSON.parse((await run(["validate", dir, "--format", "json"])).stdout);
  assert.equal(j.checked, 4, "cairn.yaml, the environment and the two requests; notes.yaml is not a collection file");
  assert.equal(j.failures.length, 2);
});

test("every example in docs/file-format.md is valid against the schema it is shown for", () => {
  const md = fs.readFileSync(path.join(ROOT, "docs/file-format.md"), "utf8");
  const blocks = [...md.matchAll(/```yaml (request|folder|collection|environment)\n([\s\S]*?)```/g)];
  assert.ok(blocks.length >= 10, `expected the documented examples, found ${blocks.length}`);
  for (const [, kind, body] of blocks) ok(kind, body, `docs example (${kind})`);
  // the documented stability promise and the commands exist
  assert.match(md, /cairn validate/);
});
