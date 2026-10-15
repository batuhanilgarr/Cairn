import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const CLI = path.resolve(import.meta.dirname, "../dist/cairn.mjs");
const ROOT = path.resolve(import.meta.dirname, "../..");
let server, base, dir, hits, inFlight, maxInFlight;

const write = (rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const bench = (args) =>
  new Promise((resolve) =>
    execFile("node", [CLI, "bench", ...args], { env: { ...process.env, NO_COLOR: "1" }, cwd: dir }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })),
  );
const reset = () => {
  hits = {};
  inFlight = 0;
  maxInFlight = 0;
};

before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = (code, body) => setTimeout(() => (inFlight--, res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body))), req.url === "/slow" ? 40 : 15);
    if (req.url === "/fail") return done(500, { error: "boom" });
    return done(200, { ok: true });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-bench-"));
  write("cairn.yaml", "name: Bench API\n");
  write("environments/local.env.yaml", `name: Local\nvars:\n  - key: baseUrl\n    value: ${base}\n`);
  for (const [file, name, p] of [["a", "Fast A", "/a"], ["b", "Fast B", "/b"], ["slow", "Slow", "/slow"], ["fail", "Failing", "/fail"]]) {
    write(`reqs/${file}.req.yaml`, `name: ${name}\nmethod: GET\nurl: '{{baseUrl}}${p}'\n`);
  }
  write("expect500/x.req.yaml", `name: Expected failure\nmethod: GET\nurl: '{{baseUrl}}/fail'\ntests:\n  - kind: status\n    op: eq\n    value: '500'\n`);
  write("two/a.req.yaml", `name: Fast A\nmethod: GET\nurl: '{{baseUrl}}/a'\n`);
  write("two/b.req.yaml", `name: Fast B\nmethod: GET\nurl: '{{baseUrl}}/b'\n`);
});
after(() => server.close());

test("percentiles use the nearest rank and the latency summary is correct", async () => {
  const out = path.join(os.tmpdir(), `cairn-stats-${process.pid}.mjs`);
  await build({ entryPoints: [path.join(ROOT, "cli/src/stats.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { percentile, latencyOf } = await import(out);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 0.5), 50);
  assert.equal(percentile(hundred, 0.95), 95);
  assert.equal(percentile(hundred, 0.99), 99);
  assert.equal(percentile([7], 0.99), 7, "one sample is every percentile");
  assert.ok(Number.isNaN(percentile([], 0.5)));
  assert.equal(latencyOf([]), null);
  const l = latencyOf([30, 10, 20, 40]);
  assert.deepEqual([l.min, l.max, l.mean, l.p50], [10, 40, 25, 20], "input order doesn't matter");
});

test("--requests sends exactly that many and --concurrency bounds the users in flight", async () => {
  reset();
  const r = await bench(["reqs/slow.req.yaml", "-c", "4", "--requests", "24", "-e", "Local", "--format", "json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.count, 24);
  assert.equal(hits["/slow"], 24, "the server saw every request once");
  assert.equal(rep.failed, 0);
  assert.equal(rep.concurrency, 4);
  assert.ok(maxInFlight <= 4, `never more than 4 at once, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 3, `really concurrent, saw ${maxInFlight}`);
  assert.deepEqual(rep.statuses, { 200: 24 });
  assert.ok(rep.latency.min >= 30 && rep.latency.p50 >= 30, `the server waits 40 ms: ${JSON.stringify(rep.latency)}`);
  assert.ok(rep.latency.p50 <= rep.latency.p95 && rep.latency.p95 <= rep.latency.p99 && rep.latency.p99 <= rep.latency.max);
  assert.ok(rep.requestsPerSecond > 0);
});

test("a folder is cycled through, so every request gets its share", async () => {
  reset();
  const r = await bench(["two", "-c", "3", "--requests", "30", "-e", "Local", "--format", "json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.count, 30);
  assert.deepEqual([hits["/a"], hits["/b"]], [15, 15]);
  assert.deepEqual(rep.perRequest.map((p) => [p.name, p.count]).sort(), [["Fast A", 15], ["Fast B", 15]]);
});

test("--duration stops on time", async () => {
  reset();
  const t0 = Date.now();
  const r = await bench(["reqs/a.req.yaml", "-c", "2", "--duration", "1", "-e", "Local", "--format", "json"]);
  const wall = Date.now() - t0;
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const rep = JSON.parse(r.stdout);
  assert.ok(rep.count > 10, `it kept sending for a second: ${rep.count}`);
  assert.ok(rep.durationMs >= 950 && rep.durationMs < 2500, `duration ${rep.durationMs}`);
  assert.ok(wall < 6000);
});

test("errors: a 5xx without tests is an error, a passing test on a 500 is not, and limits decide the exit code", async () => {
  reset();
  let r = await bench(["reqs/fail.req.yaml", "-c", "2", "--requests", "10", "-e", "Local", "--format", "json"]);
  let rep = JSON.parse(r.stdout);
  assert.equal(rep.failed, 10);
  assert.equal(rep.errorRate, 1);
  assert.equal(r.code, 0, "without a limit, errors are reported but are not an exit-code failure by themselves");
  r = await bench(["reqs/fail.req.yaml", "-c", "2", "--requests", "10", "-e", "Local", "--max-error-rate", "5", "--format", "json"]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout).problems[0], /error rate 100\.00 % is above 5 %/);

  r = await bench(["expect500", "-c", "2", "--requests", "10", "-e", "Local", "--max-error-rate", "0", "--format", "json"]);
  rep = JSON.parse(r.stdout);
  assert.equal(rep.failed, 0, "the request has a test that expects 500, and it passes");
  assert.equal(r.code, 0);
});

test("--max-p95 and --max-p99 fail the run when latency is above the limit", async () => {
  reset();
  let r = await bench(["reqs/slow.req.yaml", "-c", "2", "--requests", "8", "-e", "Local", "--max-p95", "5", "--max-p99", "5000", "--format", "json"]);
  assert.equal(r.code, 1);
  const problems = JSON.parse(r.stdout).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^p95 .* ms is above 5 ms$/);
  r = await bench(["reqs/slow.req.yaml", "-c", "2", "--requests", "8", "-e", "Local", "--max-p95", "5000", "--format", "json"]);
  assert.equal(r.code, 0, r.stdout);
});

test("the text report names what was measured", async () => {
  reset();
  const r = await bench(["two", "-c", "2", "--requests", "10", "-e", "Local"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Load test: Bench API/);
  assert.match(r.stdout, /2 users · [\d.]+ s · 10 requests · [\d.]+ requests\/s/);
  assert.match(r.stdout, /Errors: 0/);
  assert.match(r.stdout, /Latency \(ms\): min [\d.]+ {2}mean [\d.]+ {2}p50 [\d.]+ {2}p90 [\d.]+ {2}p95 [\d.]+ {2}p99 [\d.]+ {2}max [\d.]+/);
  assert.match(r.stdout, /Status: 200: 10/);
  assert.match(r.stdout, /GET {4}Fast A {2}5 requests, 0 failed/);
});

test("usage errors exit with code 2 and say what is wrong", async () => {
  for (const [args, msg] of [
    [[], /Tell me what to load test/],
    [["reqs/a.req.yaml", "-c", "0"], /--concurrency expects a whole number from 1 to 500/],
    [["reqs/a.req.yaml", "-c", "501"], /from 1 to 500/],
    [["reqs/a.req.yaml", "--duration", "abc"], /--duration expects a number/],
    [["reqs/a.req.yaml", "--duration", "0"], /--duration expects 1 to 3600 seconds/],
    [["reqs/a.req.yaml", "--requests", "1.5"], /--requests expects a whole number/],
    [["reqs/a.req.yaml", "--format", "xml"], /--format expects text or json/],
    [["nope.req.yaml"], /Not found: nope.req.yaml/],
  ]) {
    const r = await bench(args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, msg);
  }
});
