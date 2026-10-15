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
let C;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-l-")), "m.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/lib/collection.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"),
      "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts"),
    },
  });
  C = await import(out);
});

test("paths: normalize, relative and link text", () => {
  assert.equal(C.normalizePath("/a/b/../c/./d"), "/a/c/d");
  assert.equal(C.normalizePath("/a/../../b"), "/b");
  assert.equal(C.relativePath("/c/orders", "/c/shared/login.req.yaml"), "../shared/login.req.yaml");
  assert.equal(C.relativePath("/c", "/c/shared/login.req.yaml"), "shared/login.req.yaml");
  assert.equal(C.relativePath("/x/y/z", "/x/other/a.req.yaml"), "../../other/a.req.yaml");
  assert.equal(C.linkText("/c/orders/login.req.yaml", "/c/shared/login.req.yaml"), "use: ../shared/login.req.yaml\n");
});

test("a link file is recognised, an ordinary request is not", () => {
  assert.equal(C.linkTarget("use: ../shared/a.req.yaml\n", "/c/orders/a.req.yaml"), "/c/shared/a.req.yaml");
  assert.equal(C.linkTarget('use: "/abs/a.req.yaml"\n', "/c/orders/a.req.yaml"), "/abs/a.req.yaml");
  assert.equal(C.linkTarget("name: x\nmethod: GET\nurl: https://x\n", "/c/a.req.yaml"), null);
  assert.equal(C.linkTarget("name: x\nbody:\n  content: |-\n    use: not a link\nmethod: GET\n", "/c/a.req.yaml"), null);
  assert.equal(C.linkTarget("", "/c/a.req.yaml"), null);
});

test("readRequest follows a link, keeps the link's path, and says what is wrong when it can't", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-link-"));
  fs.mkdirSync(path.join(dir, "shared"));
  fs.mkdirSync(path.join(dir, "orders"));
  fs.writeFileSync(path.join(dir, "shared/login.req.yaml"), "name: Login\nmethod: POST\nurl: https://x/login\n");
  fs.writeFileSync(path.join(dir, "orders/login.req.yaml"), "use: ../shared/login.req.yaml\n");
  const t = await C.readRequest(path.join(dir, "orders/login.req.yaml"));
  assert.equal(t.name, "Login");
  assert.equal(t.method, "POST");
  assert.equal(t.file, path.join(dir, "orders/login.req.yaml"));
  assert.equal(t.linkTo, path.join(dir, "shared/login.req.yaml"));
  fs.writeFileSync(path.join(dir, "orders/broken.req.yaml"), "use: ../shared/missing.req.yaml\n");
  await assert.rejects(C.readRequest(path.join(dir, "orders/broken.req.yaml")), /shared request is missing/);
  fs.writeFileSync(path.join(dir, "orders/chain.req.yaml"), "use: login.req.yaml\n");
  await assert.rejects(C.readRequest(path.join(dir, "orders/chain.req.yaml")), /can't itself be a link/);
  const plain = await C.readRequest(path.join(dir, "shared/login.req.yaml"));
  assert.equal(plain.linkTo, undefined);
});

test("CLI: a shared request runs in each place with that place's own folder defaults", async () => {
  const seen = [];
  const server = http.createServer((req, res) => (seen.push({ url: req.url, team: req.headers["x-team"] }), res.writeHead(200, { "content-type": "application/json" }), res.end("{}")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-link-cli-"));
  fs.writeFileSync(path.join(dir, "cairn.yaml"), "name: T\n");
  for (const team of ["red", "blue"]) {
    fs.mkdirSync(path.join(dir, team));
    fs.writeFileSync(path.join(dir, team, "folder.yaml"), `headers:\n  - key: X-Team\n    value: ${team}\n`);
    fs.writeFileSync(path.join(dir, team, "ping.req.yaml"), "use: ../shared/ping.req.yaml\n");
  }
  fs.mkdirSync(path.join(dir, "shared"));
  fs.writeFileSync(path.join(dir, "shared/ping.req.yaml"), `name: Ping\nmethod: GET\nurl: ${base}/ping\ntests:\n  - kind: status\n    op: eq\n    value: "200"\n`);
  fs.writeFileSync(path.join(dir, "blue/dangling.req.yaml"), "use: ../shared/nope.req.yaml\n");
  const run = (target) => new Promise((resolve) => execFile("node", [CLI, "run", target], { env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  try {
    const red = await run(path.join(dir, "red"));
    assert.equal(red.code, 0, red.stdout + red.stderr);
    const blue = await run(path.join(dir, "blue/ping.req.yaml"));
    assert.equal(blue.code, 0, blue.stdout + blue.stderr);
    assert.deepEqual(seen.map((s) => s.team), ["red", "blue"], "same request, each folder's own header");
    const dang = await run(path.join(dir, "blue/dangling.req.yaml"));
    assert.notEqual(dang.code, 0);
    assert.match(dang.stdout + dang.stderr, /Couldn't read the request file/);
  } finally {
    server.close();
  }
});
