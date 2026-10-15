import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let S;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-s-")), "m.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/secrets.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  S = await import(out);
});

// Fake credentials are assembled at run time so this file itself never contains a token that scanners would flag.
const fake = {
  github: () => "gh" + "p_" + "a1B2c3D4".repeat(5),
  aws: () => "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  stripe: () => "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  jwt: () => ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTYifQ", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join("."),
  openai: () => "sk" + "-" + "proj-" + "abcdEFGH1234ijklMNOP5678",
  google: () => "AI" + "za" + "SyA-1234567890abcdefghijklmnopqrstu",
  slack: () => "xo" + "xb-" + "1234567890-abcdefghijkl",
};
const scan = (text, file = "/c/r.req.yaml") => S.scanText(file, text);
const rules = (text) => scan(text).map((f) => f.rule);

test("known token formats are found, with a masked preview that never holds the whole secret", () => {
  for (const [name, make, rule] of [["github", fake.github, "github-token"], ["aws", fake.aws, "aws-access-key"], ["stripe", fake.stripe, "stripe-key"], ["jwt", fake.jwt, "jwt"], ["openai", fake.openai, "openai-key"], ["google", fake.google, "google-api-key"], ["slack", fake.slack, "slack-token"]]) {
    const secret = make();
    const f = scan(`name: x\nheaders:\n  - key: X-Thing\n    value: ${secret}\n`);
    assert.ok(f.some((x) => x.rule === rule), `${name}: expected ${rule}, got ${f.map((x) => x.rule)}`);
    for (const x of f) {
      assert.ok(!x.preview.includes(secret), `${name}: the preview leaks the secret`);
      assert.ok(x.preview.length < secret.length + 4 && /chars\)/.test(x.preview), `${name}: ${x.preview}`);
    }
  }
  assert.deepEqual(rules("note: -----BEGIN RSA PRIVATE KEY-----\n"), ["private-key"]);
});

test("literal credentials in auth, headers and variables are found by their key name", () => {
  const f = scan(`auth:\n  mode: bearer\n  token: realLookingValue123456\n  password: hunter2hunter2\n`);
  assert.deepEqual(f.map((x) => [x.rule, x.where, x.line]), [["sensitive-key", "token", 3], ["sensitive-key", "password", 4]]);
  const h = scan(`headers:\n  - key: Authorization\n    value: Token abcdefghijklmnop12345\n  - key: X-Api-Key\n    value: 9f8e7d6c5b4a3f2e1d0c\n  - key: Accept\n    value: application/json\n`);
  assert.deepEqual(h.map((x) => x.where), ["Authorization (value)", "X-Api-Key (value)"]);
  const env = scan(`name: Prod\nvars:\n  - key: apiKey\n    value: sdkjfh2398fh2398fh\n  - key: baseUrl\n    value: https://api.example.com\n  - key: dbPassword\n    value: ""\n    secret: true\n`, "/c/environments/prod.env.yaml");
  assert.deepEqual(env.map((x) => x.where), ["apiKey (value)"]);
});

test("things that look sensitive but are not: variables, placeholders, URLs, settings, booleans", () => {
  const clean = [
    "auth:\n  token: '{{token}}'\n",
    "auth:\n  password: <your password>\n",
    "headers:\n  - key: Authorization\n    value: Bearer {{token}}\n",
    "oauth:\n  tokenUrl: https://auth.example.com/oauth/token\n  authScheme: Bearer\n  clientSecret: '{{clientSecret}}'\n",
    "vars:\n  - key: password\n    value: changeme\n  - key: apiKey\n    value: your-api-key\n  - key: token\n    value: xxxxxxxx\n",
    "vars:\n  - key: dbPassword\n    value: \"\"\n    secret: true\n",
    "url: https://example.com/path?page=2&sort=name\n",
    "captures:\n  - name: token\n    path: $.access_token\n",
    "headers:\n  - key: Content-Type\n    value: application/json\n",
    "name: Get token\nmethod: POST\nurl: '{{baseUrl}}/token'\n",
    "tokenPrefix: Bearer\nsecretName: prod-db\n",
  ];
  for (const text of clean) assert.deepEqual(scan(text), [], `false positive in: ${JSON.stringify(text)}`);
});

test("secrets inside bodies and URLs: JSON fields, query strings, credentials in the URL", () => {
  const body = scan(`name: Login\nbody:\n  mode: json\n  content: |-\n    {\n      "username": "ada",\n      "password": "correct-horse-battery"\n    }\n`);
  assert.deepEqual(body.map((x) => [x.where, x.line]), [["password", 7]]);
  assert.deepEqual(rules("url: https://api.example.com/v1?api_key=abcdef1234567890&x=1\n"), ["query-secret"]);
  assert.deepEqual(rules("url: https://admin:s3cr3tpass@db.example.com/x\n"), ["url-credentials"]);
  assert.deepEqual(rules("url: https://{{user}}:{{pass}}@db.example.com/x\n"), []);
});

test("a finding is reported once even when several rules match the same text", () => {
  const t = fake.github();
  const f = scan(`auth:\n  token: ${t}\n`);
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, "github-token");
  assert.equal(f[0].severity, "high");
});

test("cairn-ignore silences a line", () => {
  assert.deepEqual(scan(`auth:\n  token: abcdefghijklmnopqrstuvwxyz # cairn-ignore\n`), []);
});

test("the fix swaps the value for a variable and leaves the rest of the line alone", () => {
  const text = `auth:\n  mode: bearer\n  token: "abcdefghijklmnop123"\nurl: https://x.io/a?api_key=zzzzzzzzzz9999&b=2\n`;
  const [tok, q] = scan(text);
  assert.equal(S.applyFix(text, tok, "apiToken"), `auth:\n  mode: bearer\n  token: "{{apiToken}}"\nurl: https://x.io/a?api_key=zzzzzzzzzz9999&b=2\n`);
  assert.equal(S.applyFix(text, q, "apiKey"), `auth:\n  mode: bearer\n  token: "abcdefghijklmnop123"\nurl: https://x.io/a?api_key={{apiKey}}&b=2\n`);
  assert.equal(S.applyFix("changed\n", tok, "x"), null, "a stale finding must not corrupt the file");
  const pk = scan("k: -----BEGIN PRIVATE KEY-----\n")[0];
  assert.equal(S.applyFix("k: -----BEGIN PRIVATE KEY-----\n", pk, "x"), null, "private keys are not auto-fixed");
  // a fixed file scans clean
  assert.deepEqual(scan(S.applyFix(text, tok, "apiToken")).filter((f) => f.rule === "sensitive-key"), []);
});

test("variable names are suggested from the key", () => {
  assert.equal(S.suggestVarName("api_key", "/c/a.req.yaml"), "apiKey");
  assert.equal(S.suggestVarName("X-Api-Key", "/c/a.req.yaml"), "xApiKey");
  assert.equal(S.suggestVarName("password", "/c/a.req.yaml"), "password");
  assert.equal(S.suggestVarName("123", "/c/login.req.yaml"), "loginSecret");
});

test("the secrets folder must be git-ignored", () => {
  assert.equal(S.checkGitignore("/c", false, null, true), null, "no repository, nothing to leak into");
  assert.equal(S.checkGitignore("/c", true, ".cairn/\n", true), null);
  assert.equal(S.checkGitignore("/c", true, "node_modules\n/.cairn\n", true), null);
  assert.equal(S.checkGitignore("/c", true, ".reqnest/\n", true), null, "the old folder name counts too");
  assert.equal(S.checkGitignore("/c", true, null, false), null, "no secrets folder yet");
  const f = S.checkGitignore("/c", true, "node_modules\n", true);
  assert.equal(f.severity, "high");
  assert.equal(f.rule, "gitignore");
});

test("severity filter and grouping", () => {
  const all = scan(`auth:\n  token: ${fake.github()}\n  password: hunter2hunter2\n`);
  assert.equal(all.filter((f) => S.atLeast(f, "high")).length, 1);
  assert.equal(all.filter((f) => S.atLeast(f, "medium")).length, 2);
  assert.deepEqual(S.byFile([...all, ...scan("auth:\n  token: abcdefghijkl\n", "/c/b.req.yaml")]).map(([f, l]) => [f, l.length]), [["/c/r.req.yaml", 2], ["/c/b.req.yaml", 1]]);
});

import { execFile } from "node:child_process";
const CLI = path.join(ROOT, "cli/dist/cairn.mjs");
const run = (args, cwd) => new Promise((resolve) => execFile("node", [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("CLI: cairn scan reports masked findings, exits 1, and honours --fail-on and --format json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-scan-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: T\n");
  fs.mkdirSync(path.join(dir, ".cairn"));
  fs.writeFileSync(path.join(dir, ".cairn/secrets.yaml"), `prod.env.yaml:\n  apiKey: ${fake.github()}\n`);
  fs.mkdirSync(path.join(dir, "environments"));
  const secret = fake.github();
  fs.writeFileSync(path.join(dir, "environments/prod.env.yaml"), `name: Prod\nvars:\n  - key: apiKey\n    value: ${secret}\n  - key: baseUrl\n    value: https://api.example.com\n`);
  fs.writeFileSync(path.join(dir, "ok.req.yaml"), "name: ok\nmethod: GET\nurl: '{{baseUrl}}/x'\nheaders:\n  - key: Authorization\n    value: Bearer {{apiKey}}\n");
  const r = await run(["scan", dir]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /environments\/prod\.env\.yaml/);
  assert.match(r.stdout, /GitHub token/);
  assert.ok(!r.stdout.includes(secret), "the scan output must never contain the secret");
  assert.ok(!r.stdout.includes("secrets.yaml:"), "the secrets folder itself is not scanned");
  assert.match(r.stdout, /not git-ignored/, "a repository without .cairn/ in .gitignore is flagged");
  const j = await run(["scan", dir, "--format", "json"]);
  const parsed = JSON.parse(j.stdout);
  assert.ok(parsed.findings.length >= 2);
  assert.ok(!j.stdout.includes(secret));
  assert.equal((await run(["scan", dir, "--fail-on", "never"])).code, 0);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".cairn/\n");
  fs.writeFileSync(path.join(dir, "environments/prod.env.yaml"), "name: Prod\nvars:\n  - key: apiKey\n    value: ''\n    secret: true\n");
  const clean = await run(["scan", dir]);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /No secrets found/);
  assert.notEqual((await run(["scan", dir, "--fail-on", "bogus"])).code, 0);
});
