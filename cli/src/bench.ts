import fs from "node:fs";
import { executeRequest } from "../../src/lib/pipeline";
import { linkTarget, loadChain, parseRequest } from "../../src/lib/collection";
import type { Environment, RequestTab } from "../../src/lib/types";
import type { Layer } from "../../src/lib/inherit";
import { latencyOf, type Latency } from "./stats";

/** A small load tester on top of the same request engine `cairn run` uses. */

export const BENCH_LIMITS = { concurrency: 500, durationSec: 3600, requests: 10_000_000 };

export type BenchOptions = {
  files: string[];
  root: string;
  collection: string;
  env?: Environment;
  base: Record<string, string>;
  concurrency: number;
  /** Stop after this long; unset means "until --requests is reached". */
  durationMs?: number;
  /** Stop after this many requests in total. */
  requests?: number;
  /** Start the users one after another over this long. */
  rampMs?: number;
  timeoutMs?: number;
  insecure?: boolean;
  onNote?: (msg: string) => void;
  onTick?: (done: number, failed: number, elapsedMs: number) => void;
  /** Set to true to stop early; what has been measured so far is still reported. */
  signal?: { stop: boolean };
};

export type BenchStats = { count: number; failed: number; errorRate: number; latency: Latency | null; statuses: Record<string, number>; firstError?: string };
export type BenchReport = BenchStats & {
  collection: string;
  environment?: string;
  concurrency: number;
  durationMs: number;
  requestsPerSecond: number;
  perRequest: (BenchStats & { name: string; method: string; url: string })[];
  skipped: string[];
  stoppedEarly: boolean;
};

type Sample = { ms: number; status?: number; failed: boolean; error?: string };

function statsOf(samples: Sample[]): BenchStats {
  const statuses: Record<string, number> = {};
  for (const s of samples) {
    const k = s.status === undefined ? "error" : String(s.status);
    statuses[k] = (statuses[k] ?? 0) + 1;
  }
  const failed = samples.filter((s) => s.failed).length;
  return {
    count: samples.length,
    failed,
    errorRate: samples.length ? failed / samples.length : 0,
    latency: latencyOf(samples.map((s) => s.ms)),
    statuses,
    firstError: samples.find((s) => s.error)?.error,
  };
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const targets: { tab: RequestTab; layers: Layer[]; file: string }[] = [];
  const skipped: string[] = [];
  for (const file of o.files) {
    let tab: RequestTab;
    try {
      const text = fs.readFileSync(file, "utf8");
      const shared = linkTarget(text, file);
      tab = parseRequest(shared ? fs.readFileSync(shared, "utf8") : text, file);
    } catch (e) {
      skipped.push(`${file}: couldn't be read (${(e as Error).message})`);
      continue;
    }
    if (tab.kind === "ws" || tab.kind === "sio" || tab.kind === "sse" || tab.kind === "grpc") {
      skipped.push(`${tab.name}: ${tab.kind} requests can't be load tested`);
      continue;
    }
    if (o.timeoutMs) tab.timeoutMs = o.timeoutMs;
    if (o.insecure) tab.insecure = true;
    const layers: Layer[] = (await loadChain(o.root, file, o.collection)).map((l) => ({ label: l.label, defaults: l.defaults }));
    targets.push({ tab, layers, file });
  }
  if (!targets.length) throw new Error("There is nothing to load test: no HTTP request found.");

  const samples: Sample[][] = targets.map(() => []);
  const tokens = new Map();
  const started = Date.now();
  const deadline = o.durationMs ? started + o.durationMs : Infinity;
  let issued = 0;
  let done = 0;
  let failedCount = 0;
  const stop = o.signal ?? { stop: false };
  const keepGoing = () => !stop.stop && Date.now() < deadline && (o.requests === undefined || issued < o.requests);

  const ticker = o.onTick ? setInterval(() => o.onTick!(done, failedCount, Date.now() - started), 1000) : null;

  const worker = async (index: number) => {
    if (o.rampMs && o.concurrency > 1) await new Promise((r) => setTimeout(r, (o.rampMs! * index) / o.concurrency));
    const session: Record<string, string> = { ...o.base };
    while (keepGoing()) {
      const n = issued++;
      const slot = n % targets.length;
      const t = targets[slot];
      const t0 = performance.now();
      const sample: Sample = { ms: 0, failed: false };
      try {
        const out = await executeRequest(structuredClone(t.tab), { env: o.env, session, tokens, onSession: () => {}, layers: t.layers });
        sample.ms = performance.now() - t0;
        sample.status = out.response?.status;
        const testFailed = out.run.tests.some((x) => !x.passed);
        const err = out.error || (out.run.scriptError && !out.response ? out.run.scriptError : "");
        if (err) sample.error = err;
        // With tests, they decide. Without, a 4xx/5xx response counts as an error.
        sample.failed = !!err || (out.run.tests.length ? testFailed : (sample.status ?? 0) >= 400);
      } catch (e) {
        sample.ms = performance.now() - t0;
        sample.failed = true;
        sample.error = String((e as Error).message ?? e);
      }
      samples[slot].push(sample);
      done++;
      if (sample.failed) failedCount++;
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, (_, i) => worker(i)));
  if (ticker) clearInterval(ticker);
  const durationMs = Date.now() - started;
  const all = samples.flat();
  return {
    ...statsOf(all),
    collection: o.collection,
    environment: o.env?.name,
    concurrency: o.concurrency,
    durationMs,
    requestsPerSecond: durationMs > 0 ? all.length / (durationMs / 1000) : 0,
    perRequest: targets.map((t, i) => ({ ...statsOf(samples[i]), name: t.tab.name, method: t.tab.method, url: t.tab.url })),
    skipped,
    stoppedEarly: !!stop.stop,
  };
}

export type Thresholds = { maxErrorRate?: number; maxP95?: number; maxP99?: number };

/** What went past a limit given on the command line. */
export function checkThresholds(r: BenchReport, t: Thresholds): string[] {
  const out: string[] = [];
  if (t.maxErrorRate !== undefined && r.errorRate * 100 > t.maxErrorRate) out.push(`error rate ${(r.errorRate * 100).toFixed(2)} % is above ${t.maxErrorRate} %`);
  if (t.maxP95 !== undefined && r.latency && r.latency.p95 > t.maxP95) out.push(`p95 ${r.latency.p95.toFixed(1)} ms is above ${t.maxP95} ms`);
  if (t.maxP99 !== undefined && r.latency && r.latency.p99 > t.maxP99) out.push(`p99 ${r.latency.p99.toFixed(1)} ms is above ${t.maxP99} ms`);
  if ((t.maxP95 !== undefined || t.maxP99 !== undefined) && !r.latency) out.push("no request completed, so latency limits can't be met");
  return out;
}

const ms = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

export function formatBench(r: BenchReport, c: { red: (s: string) => string; green: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string; yellow: (s: string) => string }): string {
  const lines: string[] = [];
  const unit = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
  lines.push(c.bold(`Load test: ${r.collection}`) + c.dim(r.environment ? `  (environment ${r.environment})` : ""));
  lines.push(`  ${unit(r.concurrency, "user")} · ${(r.durationMs / 1000).toFixed(1)} s · ${unit(r.count, "request")} · ${r.requestsPerSecond.toFixed(1)} requests/s${r.stoppedEarly ? c.yellow("  (stopped early)") : ""}`);
  lines.push(`  Errors: ${r.failed ? c.red(`${r.failed} (${(r.errorRate * 100).toFixed(2)} %)`) : c.green("0")}`);
  if (r.latency) {
    const l = r.latency;
    lines.push(`  Latency (ms): min ${ms(l.min)}  mean ${ms(l.mean)}  p50 ${ms(l.p50)}  p90 ${ms(l.p90)}  p95 ${ms(l.p95)}  p99 ${ms(l.p99)}  max ${ms(l.max)}`);
  }
  const st = Object.entries(r.statuses).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join("  ");
  if (st) lines.push(`  Status: ${st}`);
  if (r.perRequest.length > 1) {
    lines.push("");
    for (const p of r.perRequest) {
      const l = p.latency;
      lines.push(`  ${p.method.padEnd(6)} ${p.name}  ${c.dim(`${p.count} requests, ${p.failed ? c.red(`${p.failed} failed`) : "0 failed"}${l ? `, p50 ${ms(l.p50)} ms, p95 ${ms(l.p95)} ms, p99 ${ms(l.p99)} ms` : ""}`)}`);
    }
  }
  if (r.firstError) lines.push("", c.dim(`  First error: ${r.firstError.split("\n")[0]}`));
  for (const s of r.skipped) lines.push(c.yellow(`  skipped: ${s}`));
  return lines.join("\n");
}
