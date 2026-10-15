import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let H;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-har-")), "m.mjs");
  await build({
    stdin: { contents: `export * from "./src/lib/har.ts"; export * from "./src/lib/secrets.ts"; export { serializeRequest } from "./src/lib/collection.ts";`, resolveDir: ROOT },
    outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"),
      "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts"),
    },
  });
  H = await import(out);
});

// credential-shaped values are assembled at run time so this file holds none
const GH = "gh" + "p_" + "a1B2c3D4".repeat(5);
const SESSION = "s3ss10n-" + "x9Y8z7".repeat(4);
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const entry = (over) => ({
  startedDateTime: "2026-10-01T10:00:00.000Z",
  _resourceType: "xhr",
  request: { method: "GET", url: "https://api.shop.example/v1/items", headers: [], queryString: [], ...over.request },
  response: { status: 200, statusText: "OK", headers: [], content: { mimeType: "application/json", text: "{}" }, ...over.response },
  ...(over.top ?? {}),
});
const har = (...entries) => JSON.stringify({ log: { version: "1.2", creator: { name: "WebInspector" }, entries } });

test("detects HAR files", () => {
  assert.equal(H.isHar(har()), true);
  assert.equal(H.isHar('{"info":{},"item":[]}'), false);
  assert.equal(H.isHar("nope"), false);
  assert.throws(() => H.parseHar('{"log":{}}', "x"), /isn't a HAR/);
});

test("API calls are kept; pages, scripts, images, fonts, preflights and non-http are skipped and counted", () => {
  const r = H.parseHar(har(
    entry({ request: { url: "https://app.shop.example/" }, top: { _resourceType: "document" }, response: { content: { mimeType: "text/html", text: "<html>" } } }),
    entry({ request: { url: "https://app.shop.example/main.js" }, top: { _resourceType: "script" } }),
    entry({ request: { url: "https://cdn.shop.example/logo.png" }, top: { _resourceType: "image" } }),
    entry({ request: { method: "OPTIONS", url: "https://api.shop.example/v1/items" }, top: { _resourceType: "preflight" } }),
    entry({ request: { url: "data:image/png;base64,AAAA" } }),
    entry({ request: { url: "https://api.shop.example/v1/items" } }),
    entry({ request: { url: "https://api.shop.example/v1/orders" }, top: { _resourceType: "fetch" } }),
  ), "shop");
  assert.deepEqual(r.requests.map((q) => q.tab.method + " " + q.tab.url), ["GET {{baseUrl}}/v1/items", "GET {{baseUrl}}/v1/orders"]);
  assert.deepEqual(r.vars, { baseUrl: "https://api.shop.example" });
  assert.ok(r.notes.some((n) => /Skipped 3 page, script, style, image or font/.test(n)));
  assert.ok(r.notes.some((n) => /Skipped 1 preflight/.test(n)));
  const all = H.parseHar(har(entry({ request: { url: "https://app.shop.example/main.js" }, top: { _resourceType: "script" } })), "x", { includeStatic: true });
  assert.equal(all.requests.length, 1, "includeStatic keeps everything");
  // without _resourceType the response type decides
  const byMime = H.parseHar(har(entry({ top: { _resourceType: undefined }, request: { url: "https://x.io/a.css" }, response: { content: { mimeType: "text/css", text: "a{}" } } }), entry({ top: { _resourceType: undefined }, request: { url: "https://x.io/api" } })), "x");
  assert.equal(byMime.requests.length, 1);
});

test("credentials never reach the files: auth, API keys, cookies, query, JSON and form fields, URL passwords", () => {
  const r = H.parseHar(har(
    entry({ request: { url: "https://api.shop.example/v1/me?api_key=" + "k".repeat(24) + "&page=2", headers: hdrs({ Authorization: "Bearer " + GH, Cookie: "sid=" + SESSION, "X-Api-Key": "key-" + "q".repeat(20), "sec-ch-ua": "x", "User-Agent": "Mozilla", Accept: "*/*", "X-Trace": "t1" }) } }),
    entry({ request: { method: "POST", url: "https://api.shop.example/v1/login", headers: hdrs({ "Content-Type": "application/json" }), postData: { mimeType: "application/json", text: JSON.stringify({ email: "ada@example.com", password: "correct-horse-battery", remember: true, nested: { client_secret: "cs-" + "z".repeat(18) } }) } } }),
    entry({ request: { method: "POST", url: "https://api.shop.example/v1/token", postData: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "grant_type", value: "password" }, { name: "password", value: "pa55w0rd-long-enough" }, { name: "scope", value: "a b" }] } } }),
    entry({ request: { url: "https://admin:hunter2hunter2@api.shop.example/v1/admin" } }),
    entry({ request: { url: "https://api.shop.example/v1/basic", headers: hdrs({ Authorization: "Basic " + Buffer.from("ada:basic-pass-1234").toString("base64") }) } }),
  ), "shop");
  const [me, login, token, admin, basic] = r.requests.map((q) => q.tab);
  assert.equal(me.authMode, "bearer");
  assert.match(me.authToken, /^\{\{token\}\}$/);
  assert.match(me.url, /api_key=\{\{apiKey\}\}&page=2/);
  assert.deepEqual(me.headers.filter((h) => h.key).map((h) => h.key), ["X-Api-Key", "X-Trace"], "cookies, browser noise, accept */* are dropped");
  assert.match(me.headers[0].value, /^\{\{.+\}\}$/);
  assert.equal(JSON.parse(login.body).email, "ada@example.com");
  assert.match(JSON.parse(login.body).password, /^\{\{password\}\}$/);
  assert.match(JSON.parse(login.body).nested.client_secret, /^\{\{.+\}\}$/);
  assert.equal(JSON.parse(login.body).remember, true);
  assert.equal(login.bodyMode, "json");
  assert.ok(!login.headers.some((h) => h.key === "Content-Type"), "implied by the body mode");
  assert.equal(token.bodyMode, "form");
  assert.match(token.body, /grant_type=password&password=\{\{password\d*\}\}&scope=a%20b/);
  assert.match(admin.url, /admin:\{\{.+\}\}@/);
  assert.equal(basic.authMode, "basic");
  assert.equal(basic.authUser, "ada");
  assert.match(basic.authPass, /^\{\{password\d*\}\}$/);
  // the values are returned for storage elsewhere
  assert.ok(Object.values(r.secrets).includes(GH));
  assert.ok(Object.values(r.secrets).includes("correct-horse-battery"));
  assert.ok(Object.values(r.secrets).includes("basic-pass-1234"));
  assert.ok(!Object.values(r.secrets).includes(SESSION), "the session cookie is dropped, not stored");
  assert.ok(r.notes.some((n) => /Cookie headers were dropped/.test(n)));
  // the property that matters: nothing in what would be written is flagged by Cairn's own secret scanner, and no value appears
  const written = r.requests.map((q) => H.serializeRequest(q.tab)).join("\n---\n");
  assert.deepEqual(H.scanText("all", written), [], "the secret scanner finds nothing in the imported files");
  for (const v of [...Object.values(r.secrets), SESSION, "ada:basic-pass-1234"]) assert.ok(!written.includes(v), `a credential was written to the files: ${v.slice(0, 6)}…`);
});

test("a token the field rules can't see (inside a text body) is still moved out by the scanner pass", () => {
  const r = H.parseHar(har(entry({ request: { method: "POST", url: "https://api.shop.example/v1/hook", postData: { mimeType: "text/plain", text: "deploy with " + GH + " now" } } })), "x");
  const t = r.requests[0].tab;
  assert.match(t.body, /^deploy with \{\{.+\}\} now$/);
  assert.ok(Object.values(r.secrets).includes(GH));
  assert.deepEqual(H.scanText("x", H.serializeRequest(t)), []);
});

test("graphql, multipart, other bodies, the base URL and several hosts", () => {
  const r = H.parseHar(har(
    entry({ request: { method: "POST", url: "https://api.shop.example/graphql", headers: hdrs({ "Content-Type": "application/json" }), postData: { mimeType: "application/json", text: JSON.stringify({ operationName: "Me", query: "query Me { me { id } }", variables: { id: 1, token: "gql-token-value-123" } }) } } }),
    entry({ request: { method: "POST", url: "https://api.shop.example/upload", postData: { mimeType: "multipart/form-data; boundary=x", params: [{ name: "title", value: "report" }, { name: "file", fileName: "report.pdf", contentType: "application/pdf" }] } } }),
    entry({ request: { method: "PUT", url: "https://other.example/x", postData: { mimeType: "application/xml", text: "<a/>" } } }),
  ), "x");
  const [g, up, xml] = r.requests;
  assert.equal(g.tab.kind, "graphql");
  assert.equal(g.tab.gql.operation, "Me");
  assert.equal(g.tab.gql.query, "query Me { me { id } }");
  assert.match(JSON.parse(g.tab.gql.variables).token, /^\{\{.+\}\}$/);
  assert.equal(up.tab.bodyMode, "multipart");
  assert.deepEqual(up.tab.formParts.map((p) => [p.key, p.kind, p.value]), [["title", "text", "report"], ["file", "file", ""]]);
  assert.ok(r.notes.some((n) => /Uploaded files aren't in a HAR.*report\.pdf/.test(n)));
  assert.equal(xml.tab.bodyMode, "text");
  assert.deepEqual(xml.tab.headers.filter((h) => h.key).map((h) => [h.key, h.value]), [["Content-Type", "application/xml"]]);
  assert.deepEqual(r.requests.map((q) => q.folder), [["api.shop.example"], ["api.shop.example"], ["other.example"]], "several hosts: one folder each");
  assert.equal(xml.tab.url, "https://other.example/x", "only the main origin becomes {{baseUrl}}");
});

test("recorded responses become examples, with credentials redacted or the example dropped", () => {
  const r = H.parseHar(har(
    entry({ request: { url: "https://api.shop.example/a" }, response: { status: 201, content: { mimeType: "application/json; charset=utf-8", text: JSON.stringify({ id: 1, access_token: "live-access-token-123", user: { name: "Ada" } }) } } }),
    entry({ request: { url: "https://api.shop.example/b" }, response: { status: 200, content: { mimeType: "text/plain", text: "key " + GH } } }),
    entry({ request: { url: "https://api.shop.example/c" }, response: { status: 200, content: { mimeType: "application/json", encoding: "base64", text: Buffer.from('{"ok":true}').toString("base64") } } }),
    entry({ request: { url: "https://api.shop.example/d" }, response: { status: 200, content: { mimeType: "application/json", text: "x".repeat(300000) } } }),
  ), "x");
  const [a, b, c, d] = r.requests.map((q) => q.tab.examples);
  assert.equal(a[0].status, 201);
  assert.equal(JSON.parse(a[0].body).access_token, "<redacted>");
  assert.equal(JSON.parse(a[0].body).user.name, "Ada");
  assert.deepEqual(b, [], "an example holding a credential is not kept");
  assert.equal(JSON.parse(c[0].body).ok, true, "base64 content is decoded");
  assert.deepEqual(d, [], "huge bodies are not kept");
  assert.ok(r.notes.some((n) => /holds a credential/.test(n)));
  const written = r.requests.map((q) => H.serializeRequest(q.tab)).join("\n");
  assert.deepEqual(H.scanText("x", written), []);
});

test("repeated polling requests are kept once and counted", () => {
  const poll = () => entry({ request: { url: "https://api.shop.example/v1/status" } });
  const r = H.parseHar(har(poll(), poll(), poll(), entry({ request: { url: "https://api.shop.example/v1/other" } })), "x");
  assert.equal(r.requests.length, 2);
  assert.ok(r.notes.some((n) => /2 repeated requests/.test(n)));
});

test("names are 'METHOD /path', files can be written, and an empty recording is handled", () => {
  const r = H.parseHar(har(entry({ request: { url: "https://api.shop.example/v1/items/42?expand=lines" } })), "x");
  assert.equal(r.requests[0].tab.name, "GET /v1/items/42");
  assert.equal(r.requests[0].base, "GET /v1/items/42");
  assert.deepEqual(H.parseHar(har(), "x").requests, []);
});

import { execFile } from "node:child_process";
const CLI_BIN = path.join(ROOT, "cli/dist/cairn.mjs");
const cairn = (args) => new Promise((resolve) => execFile("node", [CLI_BIN, ...args], { env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
const readAll = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push([p, fs.readFileSync(p, "utf8")]); } }; walk(dir); return out; };

test("CLI: cairn import har writes requests and an environment, keeps credentials out of the files, and the result passes scan and validate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-har-cli-"));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: Shop\n");
  const PASS = "correct-horse-battery";
  const file = path.join(dir, "recording.har");
  fs.writeFileSync(file, har(
    entry({ request: { url: "https://api.shop.example/v1/items?api_key=" + "k".repeat(24), headers: hdrs({ Authorization: "Bearer " + GH, Cookie: "sid=" + SESSION, "X-Trace": "t1" }) } }),
    entry({ request: { method: "POST", url: "https://api.shop.example/v1/login", headers: hdrs({ "Content-Type": "application/json" }), postData: { mimeType: "application/json", text: JSON.stringify({ email: "ada@example.com", password: PASS }) } }, response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify({ ok: true, access_token: "live-access-token-123" }) } } }),
    entry({ request: { url: "https://app.shop.example/main.js" }, top: { _resourceType: "script" } }),
  ));
  const secrets = [GH, SESSION, PASS, "k".repeat(24), "live-access-token-123"];

  const dry = await cairn(["import", "har", file, dir, "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /Would import 2 requests into “recording” \(dry run: nothing written\)/);
  assert.ok(!fs.existsSync(path.join(dir, "recording")) && !fs.existsSync(path.join(dir, "environments")), "a dry run writes nothing");

  const r = await cairn(["import", "har", file, dir]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Imported 2 requests into “recording”/);
  assert.match(r.stdout, /Environment “recording” has \{\{baseUrl\}\} and \d+ secret variables? \(kept out of the request files/);
  assert.match(r.stdout, /Skipped 1 page, script, style, image or font/);
  for (const s of secrets) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), "the command's output must never contain a credential");

  const reqFiles = fs.readdirSync(path.join(dir, "recording")).filter((f) => f.endsWith(".req.yaml"));
  assert.equal(reqFiles.length, 2);
  const env = fs.readFileSync(path.join(dir, "environments/recording.env.yaml"), "utf8");
  assert.match(env, /baseUrl/);
  assert.match(env, /secret: true/);
  // the secret values live in the git-ignored secrets file, and nowhere else on disk
  const secretsFile = fs.readFileSync(path.join(dir, ".cairn/secrets.yaml"), "utf8");
  assert.ok(secretsFile.includes(GH) && secretsFile.includes(PASS));
  for (const [p, text] of readAll(dir)) {
    if (p.includes(`${path.sep}.cairn${path.sep}`) || p.endsWith("recording.har")) continue;
    for (const s of secrets) assert.ok(!text.includes(s), `a credential was written to ${path.relative(dir, p)}`);
  }
  const scan = await cairn(["scan", dir, "--fail-on", "low"]);
  assert.equal(scan.code, 0, scan.stdout);
  const valid = await cairn(["validate", dir]);
  assert.equal(valid.code, 0, valid.stdout);

  // --all keeps the script too, --name picks the folder, --format json is machine readable and still secret-free
  const all = await cairn(["import", "har", file, dir, "--all", "--name", "everything", "--format", "json"]);
  assert.equal(all.code, 0, all.stdout + all.stderr);
  const j = JSON.parse(all.stdout);
  assert.equal(j.title, "everything");
  assert.equal(j.requests.length, 3);
  assert.equal(j.wrote, true);
  for (const s of secrets) assert.ok(!all.stdout.includes(s));
  assert.ok(fs.existsSync(path.join(dir, "everything")));
});

test("CLI: cairn import har says what is wrong instead of writing anything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-har-bad-"));
  const bad = path.join(dir, "bad.har");
  fs.writeFileSync(bad, '{"not": "a har"}');
  const good = path.join(dir, "good.har");
  fs.writeFileSync(good, har(entry({})));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: C\n");
  const notHar = await cairn(["import", "har", bad, dir]);
  assert.notEqual(notHar.code, 0);
  assert.match(notHar.stdout + notHar.stderr, /isn't a HAR recording/);
  const missing = await cairn(["import", "har", path.join(dir, "nope.har"), dir]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stdout + missing.stderr, /Not found/);
  const noColl = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-har-nocoll-"));
  const notColl = await cairn(["import", "har", good, noColl]);
  assert.notEqual(notColl.code, 0);
  assert.match(notColl.stdout + notColl.stderr, /isn't a Cairn collection/);
  assert.deepEqual(fs.readdirSync(noColl), [], "nothing is written outside a collection");
  assert.notEqual((await cairn(["import", "wsdl", good, dir])).code, 0);
  assert.notEqual((await cairn(["import", "har"])).code, 0);
  // an empty recording is not an error to write, but it says so and exits 1
  const empty = path.join(dir, "empty.har");
  fs.writeFileSync(empty, har());
  const e = await cairn(["import", "har", empty, dir]);
  assert.equal(e.code, 1);
  assert.match(e.stdout, /Nothing to import/);
});
