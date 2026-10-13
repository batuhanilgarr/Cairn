import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const CLI = path.resolve(import.meta.dirname, "../dist/reqnest.mjs");
let server, base, dir;
const seen = [];

function write(rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const run = (args, env = {}) =>
  new Promise((resolve) =>
    execFile("node", [CLI, "run", ...args], { env: { ...process.env, NO_COLOR: "1", ...env }, cwd: dir }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })),
  );

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, obj, headers = {}) => (res.writeHead(code, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(obj)));
      if (req.url === "/login") return json(200, { token: "abc123", user: { name: "Ada" } }, { "set-cookie": "sid=s1; Path=/" });
      if (req.url === "/me") {
        if (req.headers.authorization !== "Bearer abc123" || req.headers["x-api"] !== "team") return json(401, { error: "nope" });
        if (!String(req.headers.cookie).includes("sid=s1")) return json(401, { error: "no cookie" });
        return json(200, { name: "Ada" });
      }
      if (req.url === "/token") return json(200, { access_token: "CCTOKEN", expires_in: 3600, token_type: "Bearer" });
      if (req.url === "/protected") return json(req.headers.authorization === "Bearer CCTOKEN" ? 200 : 401, { ok: true });
      if (req.url.startsWith("/echo")) return json(200, { q: new URL(req.url, "http://x").searchParams.get("name"), body });
      if (req.url === "/redirect") return res.writeHead(302, { location: "/echo?name=redirected" }), res.end();
      if (req.url === "/bin") return res.writeHead(200, { "content-type": "image/png" }), res.end(Buffer.from([1, 2, 3, 255]));
      return json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reqnest-cli-"));
  write("reqnest.yaml", "name: Demo API\n");
  write("environments/local.env.yaml", `name: Local\nvars:\n  - key: baseUrl\n    value: ${base}\n  - key: clientSecret\n    value: ""\n    secret: true\n`);
  // collection-wide defaults: header + bearer token taken from a variable set by the login request
  write("folder.yaml", "headers:\n  - key: X-Api\n    value: team\nauth:\n  mode: bearer\n  token: '{{token}}'\n");
  write("ok/01-login.req.yaml", `name: Login
method: POST
url: '{{baseUrl}}/login'
auth:
  mode: none
tests:
  - kind: status
    op: eq
    value: "200"
  - kind: json
    path: $.user.name
    op: eq
    value: Ada
capture:
  - variable: token
    from: json
    path: $.token
scripts:
  post: |-
    test('token captured', () => expect(res.json().token).toBe('abc123'));
    env.set('seen', 'yes');
`);
  write("ok/02-me.req.yaml", `name: Who am I
method: GET
url: '{{baseUrl}}/me'
auth:
  mode: inherit
tests:
  - kind: status
    op: eq
    value: "200"
  - kind: json
    path: name
    op: eq
    value: Ada
`);
  write("ok/03-oauth.req.yaml", `name: Client credentials
method: GET
url: '{{baseUrl}}/protected'
auth:
  mode: oauth2
  grant: client_credentials
  tokenUrl: '{{baseUrl}}/token'
  clientId: cid
  clientSecret: '{{clientSecret}}'
tests:
  - kind: status
    op: eq
    value: "200"
`);
  write("ok/04-redirect-and-vars.req.yaml", `name: Redirect and variables
method: GET
url: '{{baseUrl}}/redirect'
tests:
  - kind: json
    path: q
    op: eq
    value: redirected
  - kind: body
    op: contains
    value: redirected
scripts:
  pre: env.set('x', '1');
`);
  write("dynamic/01-dynamic.req.yaml", `name: Dynamic variables
method: POST
url: '{{baseUrl}}/echo?name={{$guid}}'
auth:
  mode: none
body:
  mode: json
  content: '{"a":"{{$guid}}","b":"{{$guid}}","ts":{{$timestamp}},"n":{{$randomInt}},"email":"{{$randomEmail}}","mine":"{{$isoTimestamp}}","nope":"{{$notReal}}"}'
tests:
  - kind: json
    path: q
    op: matches
    value: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
`);
  write("upload/note.txt", "FILEDATA-123");
  write("upload/01-multipart.req.yaml", `name: Multipart upload
method: POST
url: '{{baseUrl}}/echo'
auth:
  mode: none
body:
  mode: multipart
  parts:
    - key: title
      value: Hello {{baseUrl}}
    - key: doc
      file: ${path.join(dir, "upload/note.txt")}
      contentType: text/plain
tests:
  - kind: status
    op: eq
    value: "200"
  - kind: body
    op: contains
    value: filename=\\"note.txt\\"
  - kind: body
    op: contains
    value: FILEDATA-123
`);
  write("upload/02-binary.req.yaml", `name: Raw file body
method: PUT
url: '{{baseUrl}}/echo'
auth:
  mode: none
body:
  mode: binary
  content: ${path.join(dir, "upload/note.txt")}
tests:
  - kind: json
    path: body
    op: eq
    value: FILEDATA-123
`);
  write("failing/05-fails.req.yaml", `name: Expects 201
method: GET
url: '{{baseUrl}}/echo?name=a'
auth:
  mode: none
tests:
  - kind: status
    op: eq
    value: "201"
  - kind: json
    path: q
    op: eq
    value: a
`);
  write("failing/06-script-error.req.yaml", `name: Throws
method: GET
url: '{{baseUrl}}/echo'
scripts:
  pre: throw new Error('boom');
`);
  write("data/07-echo.req.yaml", `name: Echo name
method: GET
url: '{{baseUrl}}/echo?name={{who}}'
auth:
  mode: none
tests:
  - kind: json
    path: q
    op: eq
    value: '{{who}}'
`);
});

after(() => server.close());

test("--help and --version, usage errors exit 2", async () => {
  assert.equal((await run(["--help"])).code, 0);
  const r = await run([path.join(dir, "nope")]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Not found/);
  const e = await run([path.join(dir, "ok"), "--env", "Missing"]);
  assert.equal(e.code, 2);
  assert.match(e.stderr, /No environment "Missing".*Local/);
});

test("a passing folder: inheritance, captures, scripts, cookies, OAuth, redirects; exit 0 and JUnit", async () => {
  seen.length = 0;
  const junit = path.join(dir, "out.xml");
  const r = await run([path.join(dir, "ok"), "--junit", junit, "--json", path.join(dir, "out.json")]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /4 requests, 0 failed/);
  // the login's captured token flowed into the next request through the inherited bearer auth
  const me = seen.find((s) => s.url === "/me");
  assert.equal(me.headers.authorization, "Bearer abc123");
  assert.equal(me.headers["x-api"], "team");
  assert.match(me.headers.cookie, /sid=s1/);
  // OAuth client credentials: token fetched with Basic auth, then used
  const tok = seen.find((s) => s.url === "/token");
  assert.equal(tok.headers.authorization, "Basic " + Buffer.from("cid:").toString("base64"));
  assert.equal(seen.find((s) => s.url === "/protected").headers.authorization, "Bearer CCTOKEN");
  const xml = fs.readFileSync(junit, "utf8");
  assert.match(xml, /<testsuites name="Demo API" tests="\d+" failures="0"/);
  assert.match(xml, /Login › status equals 200/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8"));
  assert.equal(json.results.length, 4);
  assert.equal(json.environment, "Local");
});

test("failures exit 1 and are explained, in console and JUnit", async () => {
  const junit = path.join(dir, "fail.xml");
  const r = await run([path.join(dir, "failing"), "--junit", junit]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ Expects 201/);
  assert.match(r.stdout, /status equals 201 — got 200/);
  assert.match(r.stdout, /Pre-request script: boom/);
  const xml = fs.readFileSync(junit, "utf8");
  assert.match(xml, /<failure message="got 200"/);
  assert.match(xml, /<failure message="Pre-request script: boom"/);
  assert.match(xml, /failures="2"/);
});

test("--bail stops at the first failure", async () => {
  const r = await run([path.join(dir, "failing"), "--bail"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1 requests, 1 failed/);
});

test("data-driven runs: one iteration per CSV row, values become variables", async () => {
  fs.writeFileSync(path.join(dir, "people.csv"), 'who\nada\n"grace, h"\n');
  seen.length = 0;
  const r = await run([path.join(dir, "data"), "--data", path.join(dir, "people.csv")]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 requests, 0 failed/);
  assert.deepEqual(seen.filter((s) => s.url.startsWith("/echo")).map((s) => decodeURIComponent(s.url.split("name=")[1])), ["ada", "grace, h"]);
});

test("--var and REQNEST_VAR_ both feed variables; --var wins", async () => {
  seen.length = 0;
  const r = await run([path.join(dir, "data/07-echo.req.yaml"), "--var", "who=cli"], { REQNEST_VAR_who: "env" });
  assert.equal(r.code, 0, r.stdout);
  assert.match(seen.at(-1).url, /name=cli/);
  seen.length = 0;
  await run([path.join(dir, "data/07-echo.req.yaml")], { REQNEST_VAR_who: "fromenv" });
  assert.match(seen.at(-1).url, /name=fromenv/);
});

test("HTML report is written", async () => {
  const out = path.join(dir, "r.html");
  await run([path.join(dir, "ok"), "--html", out]);
  assert.match(fs.readFileSync(out, "utf8"), /Demo API/);
});

test("multipart/form-data and raw file bodies are sent with a generated boundary", async () => {
  const { code, stdout, stderr } = await run(["upload", "--env", "Local"]);
  assert.equal(code, 0, stdout + stderr);
  const mp = seen.find((r) => r.url === "/echo" && String(r.headers["content-type"]).startsWith("multipart/form-data; boundary="));
  assert.ok(mp, "multipart request reached the server");
  assert.match(mp.body, /name="title"\r\n\r\nHello http:\/\/127\.0\.0\.1:\d+\r\n/);
  const raw = seen.find((r) => r.method === "PUT");
  assert.equal(raw.headers["content-type"], "application/octet-stream");
});

test("dynamic variables are generated per use; unknown $names are left alone", async () => {
  const before = seen.length;
  const { code, stdout, stderr } = await run(["dynamic", "--env", "Local"]);
  assert.equal(code, 0, stdout + stderr);
  const req = seen.slice(before).find((r) => r.method === "POST" && r.url.startsWith("/echo?name="));
  const b = JSON.parse(req.body);
  assert.match(b.a, /^[0-9a-f-]{36}$/);
  assert.notEqual(b.a, b.b, "each {{$guid}} is a fresh value");
  assert.ok(Math.abs(b.ts - Date.now() / 1000) < 60);
  assert.ok(b.n >= 0 && b.n <= 1000);
  assert.match(b.email, /^[a-z0-9]{10}@example\.com$/);
  assert.ok(!Number.isNaN(Date.parse(b.mine)));
  assert.equal(b.nope, "{{$notReal}}");
});
