import test, { before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-kc-"));
let C, K;

// The real shim for files, an in-memory Keychain for the secret_* commands.
const fakeCore = path.join(TMP, "core.ts");
fs.writeFileSync(fakeCore, `
import { invoke as real } from ${JSON.stringify(path.join(ROOT, "cli/shims/tauri-core.ts"))};
export async function invoke(cmd: string, args: any = {}) {
  const kc = (globalThis as any).__kc;
  switch (cmd) {
    case "secret_available": return true;
    case "secret_set": if (kc.failSet) throw new Error("Couldn't save to the Keychain: denied"); kc.map.set(args.account, args.value); return;
    case "secret_get": return kc.map.get(args.account) ?? null;
    case "secret_delete": kc.map.delete(args.account); return;
    default: return real(cmd, args);
  }
}
`);

before(async () => {
  const out = path.join(TMP, "m.mjs");
  await build({
    stdin: { contents: `export * from "./src/lib/collection.ts"; export * from "./src/lib/keychain.ts";`, resolveDir: ROOT },
    outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: { "@tauri-apps/api/core": fakeCore, "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"), "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts") },
  });
  const m = await import(out);
  C = m;
  K = m;
});

const fresh = () => {
  globalThis.__kc = { map: new Map(), failSet: false };
  const dir = fs.mkdtempSync(path.join(TMP, "c-"));
  fs.mkdirSync(path.join(dir, "environments"));
  return dir.split(path.sep).join("/");
};
const kv = (key, value, extra = {}) => ({ id: key, key, value, enabled: true, secret: false, ...extra });
const allFileText = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(fs.readFileSync(p, "utf8")); } };
  walk(dir);
  return out.join("\n");
};
const env = (vars, over = {}) => ({ id: "e", name: "Prod", vars, ...over });
const SECRET = "s3cr3t-value-" + "z9".repeat(6);

test("with the Keychain as the store, the value is in the Keychain and nowhere on disk", async () => {
  const root = fresh();
  const file = await C.saveEnvironment(root, env([kv("baseUrl", "https://x"), kv("token", SECRET, { secret: true })]), "keychain");
  assert.equal(globalThis.__kc.map.get(`${root}|${path.basename(file)}|token`), SECRET);
  const disk = allFileText(root);
  assert.ok(!disk.includes(SECRET), "the secret must not be written to any file");
  assert.match(fs.readFileSync(path.join(root, ".cairn/secrets.yaml"), "utf8"), /token: "?keychain:"?/);
  assert.match(fs.readFileSync(file, "utf8"), /secret: true/);
});

test("loading reads the value back from the Keychain; a missing one is reported, not invented", async () => {
  const root = fresh();
  const file = await C.saveEnvironment(root, env([kv("token", SECRET, { secret: true }), kv("other", "o2", { secret: true })]), "keychain");
  let [e] = await C.loadEnvironments(root);
  assert.equal(e.vars.find((v) => v.key === "token").value, SECRET);
  assert.equal(e.missing, undefined);
  globalThis.__kc.map.delete(`${root}|${path.basename(file)}|other`);
  [e] = await C.loadEnvironments(root);
  assert.equal(e.vars.find((v) => v.key === "other").value, "");
  assert.deepEqual(e.missing, ["other"]);
});

test("moving between the file and the Keychain keeps every value and leaves no copy behind", async () => {
  const root = fresh();
  const file = await C.saveEnvironment(root, env([kv("a", "AAAA-1111", { secret: true }), kv("b", "BBBB-2222", { secret: true }), kv("plain", "p")]), "file");
  assert.ok(allFileText(root).includes("AAAA-1111"));
  assert.equal(await C.migrateSecrets(root, "keychain"), 2);
  assert.ok(!allFileText(root).includes("AAAA-1111") && !allFileText(root).includes("BBBB-2222"), "after moving to the Keychain nothing is left in the files");
  assert.equal(globalThis.__kc.map.size, 2);
  let [e] = await C.loadEnvironments(root);
  assert.deepEqual(e.vars.filter((v) => v.secret).map((v) => v.value), ["AAAA-1111", "BBBB-2222"]);
  assert.equal(await C.migrateSecrets(root, "file"), 2);
  assert.equal(globalThis.__kc.map.size, 0, "moving back removes the Keychain entries");
  assert.ok(allFileText(root).includes("AAAA-1111"));
  [e] = await C.loadEnvironments(root);
  assert.deepEqual(e.vars.filter((v) => v.secret).map((v) => v.value), ["AAAA-1111", "BBBB-2222"]);
  assert.equal(file, e.file);
});

test("if the Keychain refuses, the value is kept in the file and the error is reported", async () => {
  const root = fresh();
  globalThis.__kc.failSet = true;
  const seen = [];
  K.keychainEvents.onError = (m) => seen.push(m);
  await C.saveEnvironment(root, env([kv("token", SECRET, { secret: true })]), "keychain");
  K.keychainEvents.onError = null;
  assert.equal(seen.length, 1);
  assert.match(seen[0], /denied.*kept in the secrets file/);
  const [e] = await C.loadEnvironments(root);
  assert.equal(e.vars.find((v) => v.key === "token").value, SECRET, "nothing was lost");
});

test("removing a secret, un-marking it or clearing it removes its Keychain entry", async () => {
  const root = fresh();
  const base = () => [kv("a", "AAAA-1111", { secret: true }), kv("b", "BBBB-2222", { secret: true }), kv("c", "CCCC-3333", { secret: true })];
  const file = await C.saveEnvironment(root, env(base()), "keychain");
  assert.equal(globalThis.__kc.map.size, 3);
  // a removed, b no longer secret, c cleared
  await C.saveEnvironment(root, env([kv("b", "BBBB-2222"), kv("c", "", { secret: true })], { file }), "keychain");
  assert.equal(globalThis.__kc.map.size, 0);
  const disk = allFileText(root);
  assert.ok(!disk.includes("AAAA-1111"), "a removed secret is gone from disk too");
});

test("deleting an environment forgets its secrets (Keychain and file)", async () => {
  const root = fresh();
  const kcEnv = await C.saveEnvironment(root, env([kv("t", SECRET, { secret: true })], { name: "InKeychain" }), "keychain");
  const fileEnv = await C.saveEnvironment(root, env([kv("t", "plaintext-secret-9", { secret: true })], { name: "InFile" }), "file");
  const envs = await C.loadEnvironments(root);
  for (const e of envs) await C.forgetEnvironmentSecrets(root, e);
  assert.equal(globalThis.__kc.map.size, 0);
  const left = fs.existsSync(path.join(root, ".cairn/secrets.yaml")) ? fs.readFileSync(path.join(root, ".cairn/secrets.yaml"), "utf8") : "";
  assert.ok(!left.includes("plaintext-secret-9") && !left.includes("keychain:"), `no secrets left behind: ${left}`);
  assert.ok(kcEnv && fileEnv);
});

test("accounts name the collection, the environment file and the variable", () => {
  assert.equal(K.secretAccount("/c/shop", "/c/shop/environments/prod.env.yaml", "token"), "/c/shop|prod.env.yaml|token");
});

const CLI = path.join(ROOT, "cli/dist/cairn.mjs");
const sh = (args, env) => new Promise((resolve) => execFile("node", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1", ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("CLI: a secret kept in the Keychain is read through `security`; when it can't be, the run says why", { skip: process.platform !== "darwin" }, async () => {
  const seen = [];
  const server = http.createServer((req, res) => (seen.push(req.headers["x-token"] ?? ""), res.writeHead(200, { "content-type": "application/json" }), res.end("{}")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(TMP, "cli-"));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w("cairn.yaml", "name: T\n");
  w("environments/prod.env.yaml", `name: Prod\nvars:\n  - key: baseUrl\n    value: ${base}\n  - key: token\n    value: ""\n    secret: true\n`);
  w(".cairn/secrets.yaml", "prod.env.yaml:\n  token: 'keychain:'\n");
  w("r.req.yaml", "name: r\nmethod: GET\nurl: '{{baseUrl}}/x'\nheaders:\n  - key: X-Token\n    value: '{{token}}'\n");
  const bin = (name, body) => { const d = fs.mkdtempSync(path.join(TMP, name)); fs.writeFileSync(path.join(d, "security"), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return d + path.delimiter + process.env.PATH; };
  try {
    const ok = await sh(["run", dir, "--env", "Prod"], { PATH: bin("ok-", 'case "$*" in *"|token"*) echo "kc-token-value";; *) exit 44;; esac') });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(seen.pop(), "kc-token-value", "the CLI used the value from the Keychain");
    const denied = await sh(["run", dir, "--env", "Prod"], { PATH: bin("no-", "exit 128") });
    assert.equal(seen.pop(), "", "an unreadable secret stays empty");
    assert.match(denied.stdout + denied.stderr, /token is in the macOS Keychain and couldn't be read/);
    const viaVar = await sh(["run", dir, "--env", "Prod", "--var", "token=from-var"], { PATH: bin("no2-", "exit 128") });
    assert.equal(seen.pop(), "from-var", "--var still wins");
    assert.equal(viaVar.code, 0);
  } finally {
    server.close();
  }
});

test("settings: only globals that really are in the Keychain become a marker; loading never returns the marker as a value", async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const out = path.join(TMP, "settings.mjs");
  await build({ stdin: { contents: `export * from "./src/lib/settings.ts";`, resolveDir: ROOT }, outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@tauri-apps/api/core": fakeCore, "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"), "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts") }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const S = await import(out);
  const g = (key, value, secret) => ({ id: key, key, value, enabled: true, secret });
  const s = { ...S.DEFAULT_SETTINGS, globals: [g("TOKEN", "tok-1234567890", true), g("OTHER", "other-secret-99", true), g("PLAIN", "keychain:", false), g("NAME", "ada", false)] };
  S.saveSettings(s, new Set(["TOKEN"]));
  const raw = store.get("rq.settings");
  assert.ok(!raw.includes("tok-1234567890"), "a value in the Keychain is not stored in the settings");
  assert.ok(raw.includes("other-secret-99"), "a secret that is NOT confirmed in the Keychain stays in the settings: nothing is lost");
  const loaded = S.loadSettings();
  assert.deepEqual(loaded.globals.map((x) => [x.key, x.value]), [["TOKEN", ""], ["OTHER", "other-secret-99"], ["PLAIN", "keychain:"], ["NAME", "ada"]], "the marker never becomes a value; a non-secret that happens to say keychain: is untouched");
  assert.deepEqual(S.pendingGlobalSecretKeys(), ["TOKEN"]);
  assert.deepEqual(S.pendingGlobalSecretKeys(), ["TOKEN"], "asking again gives the same answer (fetching can safely be repeated)");
  S.saveSettings(s);
  assert.ok(store.get("rq.settings").includes("tok-1234567890"), "with nothing in the Keychain everything is stored as before");
});

test("Postman import flags the credentials it moves out of the files as secret globals", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "pm-"));
  const root = dir.split(path.sep).join("/");
  fs.mkdirSync(path.join(dir, "exp"));
  const col = { info: { name: "C", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [{ name: "r", request: { method: "GET", url: "https://x.io/a", auth: { type: "bearer", bearer: [{ key: "token", value: "literal-token-1234567890" }] } } }] };
  fs.writeFileSync(path.join(dir, "exp/c.json"), JSON.stringify(col));
  fs.writeFileSync(path.join(dir, "exp/g.json"), JSON.stringify({ name: "G", values: [{ key: "region", value: "eu", enabled: true }], _postman_variable_scope: "globals" }));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: T\n");
  const out = path.join(TMP, "imp.mjs");
  await build({ stdin: { contents: `export { importPostmanFiles } from "./src/lib/importer.ts";`, resolveDir: ROOT }, outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@tauri-apps/api/core": fakeCore, "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"), "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts") }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const { importPostmanFiles } = await import(out);
  const r = await importPostmanFiles(root, [`${root}/exp/c.json`, `${root}/exp/g.json`]);
  const cred = r.globals.find((x) => x.value === "literal-token-1234567890");
  assert.ok(cred, JSON.stringify(r.globals));
  assert.equal(cred.secret, true, "a credential moved out of the files is a secret global");
  assert.equal(r.globals.find((x) => x.key === "region")?.secret, undefined, "a plain Postman global is not");
});
