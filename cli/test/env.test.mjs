import test, { before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "cli/dist/cairn.mjs");
let D, C;

async function bundle(entry) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-e-")), "m.mjs");
  await build({
    entryPoints: [path.join(ROOT, entry)], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
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
  D = await bundle("src/lib/dotenv.ts");
  C = await bundle("src/lib/collection.ts");
});

test(".env files: comments, export, quotes, escapes, inline comments, multi-line values", () => {
  const env = D.parseDotenv(`# a comment
BASE_URL=https://api.example.com
export TOKEN = "abc def"   
EMPTY=
SINGLE='no \\n escapes here'
DOUBLE="line1\\nline2 \\"quoted\\""
INLINE=value # trailing comment
HASH=a#b
KEY_WITH.DOT=1
MULTI="first
second"

not a pair
`);
  assert.deepEqual(env, {
    BASE_URL: "https://api.example.com",
    TOKEN: "abc def",
    EMPTY: "",
    SINGLE: "no \\n escapes here",
    DOUBLE: 'line1\nline2 "quoted"',
    INLINE: "value",
    HASH: "a#b",
    "KEY_WITH.DOT": "1",
    MULTI: "first\nsecond",
  });
  assert.deepEqual(D.parseDotenv("\uFEFFA=1\r\nB=2\r\n"), { A: "1", B: "2" });
});

test(".env file names become environment names", () => {
  assert.equal(D.dotenvName("/x/.env.staging"), "staging");
  assert.equal(D.dotenvName("/x/.env"), "dotenv");
  assert.equal(D.dotenvName("C:\\p\\prod.env"), "prod");
});

const kv = (key, value, extra = {}) => ({ id: key + value, key, value, enabled: true, secret: false, ...extra });
const envs = [
  { id: "b", name: "Base", vars: [kv("baseUrl", "https://base"), kv("team", "core"), kv("token", "T", { secret: true })] },
  { id: "s", name: "Staging", extends: "Base", vars: [kv("baseUrl", "https://staging"), kv("flag", "on")] },
  { id: "p", name: "Prod", extends: "staging", vars: [kv("flag", "off", { enabled: false }), kv("team", "")] },
];
const val = (e, k) => e.vars.find((v) => v.key === k)?.value;

test("an environment sees its parents, and its own values win", () => {
  const e = C.effectiveEnv(envs, envs[1]);
  assert.equal(val(e, "baseUrl"), "https://staging");
  assert.equal(val(e, "team"), "core");
  assert.equal(val(e, "flag"), "on");
  assert.equal(e.vars.find((v) => v.key === "token").secret, true, "secrets stay secret when inherited");
  assert.equal(e.name, "Staging");
});

test("inheritance chains, matches names loosely, and a disabled variable does not hide the parent's", () => {
  const e = C.effectiveEnv(envs, envs[2]);
  assert.equal(val(e, "baseUrl"), "https://staging", "Prod -> Staging -> Base, nearest wins");
  assert.equal(val(e, "flag"), "on", "disabled in Prod, so Staging's value shows");
  assert.equal(val(e, "team"), "", "an enabled empty value is a real override");
});

test("a cycle or a missing parent cannot hang or crash", () => {
  const loop = [{ id: "x", name: "X", extends: "Y", vars: [kv("a", "1")] }, { id: "y", name: "Y", extends: "X", vars: [kv("b", "2")] }];
  const e = C.effectiveEnv(loop, loop[0]);
  assert.equal(val(e, "a"), "1");
  assert.equal(val(e, "b"), "2");
  const lost = { id: "z", name: "Z", extends: "Nope", vars: [kv("c", "3")] };
  assert.deepEqual(C.effectiveEnv([lost], lost), lost);
  assert.equal(C.effectiveEnv([], undefined), undefined);
  assert.deepEqual(C.envAncestors(envs, envs[2]).map((e) => e.name), ["Staging", "Base"]);
});

test("extends is saved in the environment file and read back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-env-"));
  fs.mkdirSync(path.join(dir, "environments"));
  const file = await C.saveEnvironment(dir, { id: "n", name: "Staging", extends: "Base", vars: [kv("a", "1"), kv("sec", "S", { secret: true })] });
  assert.match(fs.readFileSync(file, "utf8"), /extends: Base/);
  const [loaded] = await C.loadEnvironments(dir);
  assert.equal(loaded.extends, "Base");
  assert.equal(val(loaded, "sec"), "S");
  assert.ok(!/value: S\b/.test(fs.readFileSync(file, "utf8")), "secret values stay out of the environment file");
  assert.match(fs.readFileSync(path.join(dir, ".cairn", "secrets.yaml"), "utf8"), /sec: S/);
});

test("CLI: --env a,b layers environments, and extends works from the command line", async () => {
  const seen = [];
  const server = http.createServer((req, res) => (seen.push(req.url), res.writeHead(200, { "content-type": "application/json" }), res.end("{}")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-cli-env-"));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: T\n");
  fs.mkdirSync(path.join(dir, "environments"));
  fs.writeFileSync(path.join(dir, "environments/base.env.yaml"), `name: Base\nvars:\n  - key: host\n    value: ${base}\n  - key: who\n    value: base\n`);
  fs.writeFileSync(path.join(dir, "environments/child.env.yaml"), `name: Child\nextends: Base\nvars:\n  - key: who\n    value: child\n`);
  fs.writeFileSync(path.join(dir, "environments/extra.env.yaml"), `name: Extra\nvars:\n  - key: who\n    value: extra\n`);
  fs.writeFileSync(path.join(dir, "r.req.yaml"), "name: r\nmethod: GET\nurl: \"{{host}}/who/{{who}}\"\n");
  const run = (env) => new Promise((resolve) => execFile("node", [CLI, "run", dir, "--env", env], { env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  try {
    assert.equal((await run("Child")).code, 0);
    assert.equal(seen.pop(), "/who/child", "extends: the child's value wins, the parent's host is inherited");
    assert.equal((await run("Child,Extra")).code, 0);
    assert.equal(seen.pop(), "/who/extra", "a comma list layers left to right");
    const bad = await run("Child,Nope");
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr + bad.stdout, /No environment "Nope"/);
  } finally {
    server.close();
  }
});
