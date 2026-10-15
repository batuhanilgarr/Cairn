import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { executeRequest } from "../../src/lib/pipeline";
import { setNetwork } from "../../src/lib/net";
import { atLeast, formatFindings, scanDirectory, SEVERITIES } from "./scan";
import { validateDirectory } from "./validate";
import { importHar } from "./importHar";
import { BENCH_LIMITS, checkThresholds, formatBench, runBench } from "./bench";
import { buildOpenApi, collectExportItems, toJson, toYaml } from "../../src/lib/openapiExport";
import { effectiveEnv, linkTarget, loadChain, loadDefaults, loadEnvironments, parseRequest, readCollectionName } from "../../src/lib/collection";
import { listFilesRecursive } from "../../src/lib/fs";
import type { Environment, RequestTab, TestResult } from "../../src/lib/types";
import type { Layer } from "../../src/lib/inherit";
import { junitXml, htmlReport, type Report, type ReqResult } from "./reporters";

export const VERSION = "0.3.2";

const HELP = `cairn ${VERSION}: run Cairn collections from the command line

Usage
  cairn run <collection | folder | request.req.yaml> [options]
  cairn export openapi [folder] [-o file] [--format yaml|json] [--env name]
      Write the collection as an OpenAPI 3.0.3 document: requests become operations, folders tags, saved examples
      responses, auth settings security schemes. Credentials are never written. The log goes to stderr when the spec goes to stdout.
  cairn import har <file.har> [collection] [--all] [--name <title>] [--dry-run] [--format text|json]
      Import a browser recording (DevTools > Network > Save all as HAR) into a collection folder: API calls only unless
      --all, one folder per recording, tokens/passwords/keys moved into secret variables (never into the files),
      cookies dropped. --dry-run lists what would be imported and writes nothing.
  cairn validate [folder] [--format text|json]
      Check request, folder, collection and environment files against the published format schema (v1).
      Prints file:line and what is wrong; exit code 1 when anything is. The same schemas give editors completion and hover docs.
  cairn bench <request.req.yaml | folder> [-c users] [--duration sec] [--requests n] [options]
      Load test: N users send the request (or cycle through the folder's requests) at the same time and the run reports
      requests/s, errors and latency (min, mean, p50, p90, p95, p99, max). Defaults: 10 users for 10 s. Stops at whichever of
      --duration and --requests comes first; Ctrl-C stops early and still prints what was measured. With tests in a request, a failed test
      is an error; without, a 4xx or 5xx response is. Limits for CI: --max-error-rate <percent>, --max-p95 <ms>, --max-p99 <ms>
      (exit code 1 when one is exceeded). --ramp <sec> starts the users gradually; --cookies keeps cookies (off by default). Only load test servers you own or may test.
  cairn scan [folder] [--fail-on high|medium|low|never] [--format text|json]
      Look for credentials that would be committed (tokens, passwords, keys in request files, folder defaults and
      environments). Prints masked previews only. Exit code 1 when something at or above --fail-on (default medium)
      is found, so it works as a pre-commit hook or a CI step.

Options
  -e, --env <name[,name]>  Environment to use (by name or file name); a comma list layers them, later ones win.
                           An environment with an extends: line brings its parent's variables too. Defaults to the only one, if there is only one
      --var <key=value>    Set a variable (repeatable). Also: CAIRN_VAR_<name> environment variables, handy for CI secrets
  -d, --data <file>        CSV or JSON rows: run the whole set once per row, row values become variables
  -n, --iterations <n>     Repeat the run n times
      --bail               Stop at the first failing request
      --delay <ms>         Wait between requests
      --timeout <ms>       Override every request's timeout
  -k, --insecure           Skip TLS certificate verification
      --no-cookies         Don't store or send cookies
      --proxy <url>        Use this proxy
      --ca <file>          Extra trusted CA certificates (PEM)
      --junit <file>       Write a JUnit XML report
      --json <file>        Write a JSON report
      --html <file>        Write an HTML report
      --no-color           Plain output
  -h, --help               Show this help
  -v, --version            Show the version

Exit code: 0 all passed, 1 a test or request failed, 2 bad usage or configuration.
Browser sign-in (OAuth authorization code), WebSocket, SSE and gRPC requests are skipped in the CLI.
`;

class UsageError extends Error {}

const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: number) => (s: string) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32), red = c(31), dim = c(2), bold = c(1), yellow = c(33);

/* ------------------------------ data files ------------------------------ */

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  const [head, ...rest] = rows;
  if (!head) return [];
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

function loadData(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8");
  if (file.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new UsageError(`${file}: expected a JSON array of objects`);
    return data.map((r) => Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
  }
  return parseCsv(text);
}

/* ------------------------------- running ------------------------------- */

export type RunOptions = {
  target: string;
  env?: string;
  vars?: Record<string, string>;
  data?: string;
  iterations?: number;
  bail?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  insecure?: boolean;
  noCookies?: boolean;
  proxy?: string;
  ca?: string;
  onResult?: (r: ReqResult) => void;
  onNote?: (msg: string) => void;
};

function findRoot(start: string): string {
  let dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "cairn.yaml")) || fs.existsSync(path.join(d, "reqnest.yaml"))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

type Prepared = { root: string; name: string; files: string[]; env: Environment | undefined; base: Record<string, string> };

/** Find the collection, its requests and environment, and set up the network: shared by `run` and `bench`. */
async function prepareRun(o: Pick<RunOptions, "target" | "env" | "vars" | "proxy" | "ca" | "noCookies" | "onNote">): Promise<Prepared> {
  const target = path.resolve(o.target);
  if (!fs.existsSync(target)) throw new UsageError(`Not found: ${o.target}`);
  const root = findRoot(target).split(path.sep).join("/");
  const name = (await readCollectionName(root)) ?? path.basename(root);
  const isFile = fs.statSync(target).isFile();
  const files = isFile ? [target.split(path.sep).join("/")] : await listFilesRecursive(target.split(path.sep).join("/"), ".req.yaml");
  if (!files.length) throw new UsageError(`No requests (*.req.yaml) found in ${o.target}`);

  const envs = await loadEnvironments(root);
  let env: Environment | undefined;
  if (o.env) {
    const names = o.env.split(",").map((n) => n.trim()).filter(Boolean);
    const found = names.map((n) => {
      const e = envs.find((x) => x.name.toLowerCase() === n.toLowerCase() || path.basename(x.file ?? "").replace(/\.env\.yaml$/, "") === n);
      if (!e) throw new UsageError(`No environment "${n}". Available: ${envs.map((x) => x.name).join(", ") || "none"}`);
      return e;
    });
    env = effectiveEnv(envs, found[0], found.slice(1));
    if (env && found.length > 1) env = { ...env, name: found.map((e) => e.name).join(" + ") };
  } else if (envs.length === 1) env = effectiveEnv(envs, envs[0]);
  else if (envs.length > 1) o.onNote?.(`Several environments exist (${envs.map((e) => e.name).join(", ")}); none selected. Use --env.`);

  if (env?.missing?.length) o.onNote?.(`Secret${env.missing.length > 1 ? "s" : ""} ${env.missing.join(", ")} ${env.missing.length > 1 ? "are" : "is"} in the macOS Keychain and couldn't be read here (CI, another Mac, or access denied). Pass ${env.missing.length > 1 ? "them" : "it"} with --var name=value or CAIRN_VAR_name.`);
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("CAIRN_VAR_") && v !== undefined) base[k.slice("CAIRN_VAR_".length)] = v;
  Object.assign(base, o.vars ?? {});

  setNetwork({
    proxyMode: o.proxy ? "custom" : "env",
    proxyUrl: o.proxy ?? "",
    caCert: o.ca ?? "",
    cookiesDisabled: !!o.noCookies,
  });

  return { root, name, files, env, base };
}

export async function runCollection(o: RunOptions): Promise<Report> {
  const { root, name, files, env, base } = await prepareRun(o);
  const rows = o.data ? loadData(o.data) : [];
  const iterations = rows.length || Math.max(1, o.iterations ?? 1);
  const tokens = new Map();
  const results: ReqResult[] = [];
  const started = Date.now();
  let stop = false;

  for (let it = 0; it < iterations && !stop; it++) {
    const session: Record<string, string> = { ...base, ...(rows[it] ?? {}) };
    for (const file of files) {
      if (stop) break;
      const rel = file.startsWith(root + "/") ? file.slice(root.length + 1) : path.basename(file);
      let tab: RequestTab;
      try {
        const text = fs.readFileSync(file, "utf8");
        const shared = linkTarget(text, file);
        tab = parseRequest(shared ? fs.readFileSync(shared, "utf8") : text, file);
      } catch (e) {
        const r: ReqResult = { file, rel, name: rel, method: "?", url: "", iteration: it + 1, tests: [], logs: [], error: `Couldn't read the request file: ${(e as Error).message}` };
        results.push(r);
        o.onResult?.(r);
        continue;
      }
      if (o.timeoutMs) tab.timeoutMs = o.timeoutMs;
      if (o.insecure) tab.insecure = true;
      const r: ReqResult = { file, rel, name: tab.name, method: tab.method, url: tab.url, iteration: it + 1, tests: [], logs: [] };
      if (tab.kind === "ws" || tab.kind === "sse" || tab.kind === "grpc") {
        r.skipped = `${tab.kind} requests aren't run by the CLI`;
      } else {
        try {
          const layers: Layer[] = (await loadChain(root, file, name)).map((l) => ({ label: l.label, defaults: l.defaults }));
          const out = await executeRequest(tab, { env, session, tokens, onSession: () => {}, layers });
          r.tests = out.run.tests;
          r.logs = out.run.logs;
          if (out.run.scriptError && !out.response) r.error = out.run.scriptError;
          if (out.error) r.error = out.error;
          if (out.response) {
            r.status = out.response.status;
            r.ms = out.response.timeMs;
            r.url = out.sent?.url ?? r.url;
          }
          if (out.sent) r.url = out.sent.url;
        } catch (e) {
          r.error = String((e as Error).message ?? e);
        }
      }
      results.push(r);
      o.onResult?.(r);
      if (o.bail && failed(r)) stop = true;
      if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
    }
  }
  return { collection: name, environment: env?.name, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, results, iterations };
}

export const failed = (r: ReqResult) => !!r.error || r.tests.some((t) => !t.passed);

/* -------------------------------- output -------------------------------- */

function printResult(r: ReqResult, showIteration: boolean) {
  const tag = showIteration ? dim(`#${r.iteration} `) : "";
  if (r.skipped) return console.log(`  ${yellow("–")} ${tag}${r.name} ${dim(r.skipped)}`);
  const ok = !failed(r);
  const passed = r.tests.filter((t) => t.passed).length;
  const meta = [r.method.padEnd(6), r.status ?? "---", r.ms !== undefined ? `${r.ms} ms` : "", r.tests.length ? `${passed}/${r.tests.length} tests` : ""].filter((x) => x !== "").join("  ");
  console.log(`  ${ok ? green("✓") : red("✗")} ${tag}${r.name}  ${dim(meta)}`);
  if (r.error) console.log(red(`      ${r.error.split("\n").join("\n      ")}`));
  for (const t of r.tests.filter((t: TestResult) => !t.passed)) console.log(red(`      ✗ ${t.name}${t.error ? ` — ${t.error}` : ""}`));
  if (!ok) for (const l of r.logs) console.log(dim(`      log: ${l}`));
}

export function summarize(rep: Report) {
  const real = rep.results.filter((r) => !r.skipped);
  const bad = real.filter(failed).length;
  const tests = real.flatMap((r) => r.tests);
  const tp = tests.filter((t) => t.passed).length;
  console.log("");
  console.log(
    `${bold("Summary")}  ${real.length} requests, ${bad ? red(`${bad} failed`) : green("0 failed")}  ·  ${tests.length} tests (${green(`${tp} passed`)}${tests.length - tp ? `, ${red(`${tests.length - tp} failed`)}` : ""})  ·  ${rep.durationMs} ms`,
  );
  const skipped = rep.results.length - real.length;
  if (skipped) console.log(dim(`${skipped} skipped`));
  return bad === 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string", short: "e" }, var: { type: "string", multiple: true }, data: { type: "string", short: "d" },
      iterations: { type: "string", short: "n" }, bail: { type: "boolean" }, delay: { type: "string" }, timeout: { type: "string" },
      insecure: { type: "boolean", short: "k" }, "no-cookies": { type: "boolean" }, proxy: { type: "string" }, ca: { type: "string" },
      junit: { type: "string" }, json: { type: "string" }, html: { type: "string" }, "no-color": { type: "boolean" },
      "fail-on": { type: "string" }, format: { type: "string" }, out: { type: "string", short: "o" },
      all: { type: "boolean" }, name: { type: "string" }, "dry-run": { type: "boolean" },
      concurrency: { type: "string", short: "c" }, cookies: { type: "boolean" }, duration: { type: "string" }, requests: { type: "string" }, ramp: { type: "string" },
      "max-error-rate": { type: "string" }, "max-p95": { type: "string" }, "max-p99": { type: "string" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(VERSION), 0;
  const [cmd, target] = positionals;
  if (values.help || !cmd) return console.log(HELP), cmd || values.help ? 0 : 2;
  if (cmd === "export") {
    if (target !== "openapi") throw new UsageError("Try: cairn export openapi <collection> [-o file] [--format yaml|json] [--env name]");
    const dir = path.resolve(positionals[2] ?? ".");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`Not a folder: ${positionals[2] ?? "."}`);
    const fmt = values.format ?? (values.out?.toLowerCase().endsWith(".json") ? "json" : "yaml");
    if (fmt !== "yaml" && fmt !== "json") throw new UsageError(`--format expects yaml or json, got "${fmt}"`);
    const root = findRoot(dir).split(path.sep).join("/");
    const name = (await readCollectionName(root)) ?? path.basename(root);
    // variables that can name the server: collection defaults and the chosen environment, never secrets
    const vars: Record<string, string> = {};
    for (const v of (await loadDefaults(root)).vars ?? []) if (v.enabled && v.key) vars[v.key] = v.value;
    const envs = await loadEnvironments(root);
    const pick = values.env ? envs.find((e) => e.name.toLowerCase() === values.env!.toLowerCase() || path.basename(e.file ?? "").replace(/\.env\.yaml$/, "") === values.env) : envs.length === 1 ? envs[0] : undefined;
    if (values.env && !pick) throw new UsageError(`No environment "${values.env}". Available: ${envs.map((e) => e.name).join(", ") || "none"}`);
    for (const v of effectiveEnv(envs, pick)?.vars ?? []) if (v.enabled && v.key && !v.secret) vars[v.key] = v.value;
    const { items, unreadable } = await collectExportItems(root, name);
    const here = dir.split(path.sep).join("/");
    const { doc, notes, operations } = buildOpenApi(items.filter((i) => i.file === here || i.file.startsWith(here + "/")), { title: name, vars });
    const text = fmt === "json" ? toJson(doc) : toYaml(doc);
    if (values.out) fs.writeFileSync(values.out, text);
    else process.stdout.write(text);
    for (const f of unreadable) notes.push(`Couldn't read ${path.relative(root, f)}.`);
    const log = values.out ? console.log : console.error;
    log(`${operations} operation${operations === 1 ? "" : "s"} exported${values.out ? ` to ${values.out}` : ""}.`);
    for (const n of notes) log(dim(`  ${n}`));
    return 0;
  }
  if (cmd === "import") {
    if (target !== "har") throw new UsageError("Try: cairn import har <file.har> [collection] [--all] [--name <title>] [--dry-run]");
    const file = positionals[2];
    if (!file) throw new UsageError("Tell me which recording to import: cairn import har <file.har> [collection]");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UsageError(`Not found: ${file}`);
    const dir = positionals[3] ?? ".";
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`Not a folder: ${dir}`);
    const root = findRoot(path.resolve(dir));
    if (!fs.existsSync(path.join(root, "cairn.yaml")) && !fs.existsSync(path.join(root, "reqnest.yaml"))) {
      throw new UsageError(`${dir} isn't a Cairn collection (no cairn.yaml here or in a parent folder). Create one in the app, or add a cairn.yaml containing "name: My API".`);
    }
    const r = await importHar({ file, collection: root, name: values.name, includeStatic: !!values.all, dryRun: !!values["dry-run"] });
    if (values.format === "json") console.log(JSON.stringify({ ...r, collection: root }, null, 2));
    else {
      console.log(r.requests.length ? `${r.wrote ? "Imported" : "Would import"} ${r.requests.length} request${r.requests.length === 1 ? "" : "s"} into “${r.title}”${r.wrote ? "" : " (dry run: nothing written)"}` : "Nothing to import: the recording has no requests Cairn can import.");
      for (const n of r.requests.slice(0, 12)) console.log(dim(`  ${n}`));
      if (r.requests.length > 12) console.log(dim(`  …and ${r.requests.length - 12} more`));
      if (r.wrote && r.environment) console.log(`Environment “${r.environment}” has {{baseUrl}}${r.secrets ? ` and ${r.secrets} secret variable${r.secrets === 1 ? "" : "s"} (kept out of the request files; see .cairn/secrets.yaml)` : ""}.`);
      for (const n of r.notes) console.log(dim(`• ${n}`));
    }
    return r.requests.length ? 0 : 1;
  }
  if (cmd === "validate") {
    const dir = target ?? ".";
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`Not a folder: ${dir}`);
    const { checked, failures } = validateDirectory(dir);
    if (values.format === "json") console.log(JSON.stringify({ checked, failures }, null, 2));
    else {
      for (const f of failures) for (const p of f.problems) console.log(`${f.file}:${p.line}  ${p.path ? p.path + "  " : ""}${p.message}`);
      const n = failures.reduce((a, f) => a + f.problems.length, 0);
      console.log(failures.length ? red(`${n} problem${n === 1 ? "" : "s"} in ${failures.length} of ${checked} file${checked === 1 ? "" : "s"}`) : green(`${checked} file${checked === 1 ? "" : "s"} follow the format (schema v1)`));
    }
    return failures.length ? 1 : 0;
  }
  if (cmd === "bench") {
    if (!target) throw new UsageError("Tell me what to load test: cairn bench <request.req.yaml | folder> [-c users] [--duration sec] [--requests n]");
    const whole = (v: string | undefined, flag: string, min: number, max: number) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${flag} expects a whole number from ${min} to ${max}, got "${v}"`);
      return n;
    };
    const dec = (v: string | undefined, flag: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} expects a number, got "${v}"`);
      return n;
    };
    const concurrency = whole(values.concurrency, "--concurrency", 1, BENCH_LIMITS.concurrency) ?? 10;
    const requests = whole(values.requests, "--requests", 1, BENCH_LIMITS.requests);
    const durationSec = dec(values.duration, "--duration");
    if (durationSec !== undefined && (durationSec <= 0 || durationSec > BENCH_LIMITS.durationSec)) throw new UsageError(`--duration expects 1 to ${BENCH_LIMITS.durationSec} seconds, got "${values.duration}"`);
    const rampSec = dec(values.ramp, "--ramp") ?? 0;
    const format = values.format ?? "text";
    if (format !== "text" && format !== "json") throw new UsageError(`--format expects text or json, got "${format}"`);
    const vars: Record<string, string> = {};
    for (const kv of values.var ?? []) {
      const i = kv.indexOf("=");
      if (i < 1) throw new UsageError(`--var expects key=value, got "${kv}"`);
      vars[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const notes: string[] = [];
    const ctx = await prepareRun({ target, env: values.env, vars, proxy: values.proxy, ca: values.ca, noCookies: !values.cookies, onNote: (m) => notes.push(m) });
    const signal = { stop: false };
    const onSigint = () => { signal.stop = true; };
    process.once("SIGINT", onSigint);
    const tty = process.stderr.isTTY && format === "text";
    const rep = await runBench({
      files: ctx.files, root: ctx.root, collection: ctx.name, env: ctx.env, base: ctx.base, concurrency,
      durationMs: durationSec !== undefined ? durationSec * 1000 : requests === undefined ? 10_000 : undefined,
      requests, rampMs: rampSec * 1000, timeoutMs: dec(values.timeout, "--timeout"), insecure: values.insecure, signal,
      onTick: tty ? (done, failedN, el) => process.stderr.write(`\r${dim(`  ${(el / 1000).toFixed(0)} s · ${done} requests · ${failedN} failed`)}   `) : undefined,
    });
    process.removeListener("SIGINT", onSigint);
    if (tty) process.stderr.write("\r\x1b[K");
    const problems = checkThresholds(rep, { maxErrorRate: dec(values["max-error-rate"], "--max-error-rate"), maxP95: dec(values["max-p95"], "--max-p95"), maxP99: dec(values["max-p99"], "--max-p99") });
    if (format === "json") console.log(JSON.stringify({ ...rep, notes, problems }, null, 2));
    else {
      for (const n of notes) console.log(yellow(`note: ${n}`));
      console.log(formatBench(rep, { red, green, dim, bold, yellow }));
      for (const p of problems) console.log(red(`  ✗ ${p}`));
    }
    return problems.length || rep.count === 0 ? 1 : 0;
  }
  if (cmd === "scan") {
    const failOn = (values["fail-on"] ?? "medium") as string;
    if (failOn !== "never" && !SEVERITIES.includes(failOn as never)) throw new UsageError(`--fail-on expects high, medium, low or never, got "${failOn}"`);
    const dir = target ?? ".";
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`Not a folder: ${dir}`);
    const findings = scanDirectory(dir);
    if (values.format === "json") console.log(JSON.stringify({ findings, failOn }, null, 2));
    else console.log(formatFindings(findings, { red, yellow, dim, bold, green }));
    return failOn !== "never" && findings.some((f) => atLeast(f, failOn as "high")) ? 1 : 0;
  }
  if (cmd !== "run") throw new UsageError(`Unknown command "${cmd}". Try: cairn run, cairn bench, cairn import har, cairn validate, cairn scan or cairn export openapi`);
  if (!target) throw new UsageError("Tell me what to run: cairn run <collection | folder | request.req.yaml>");

  const vars: Record<string, string> = {};
  for (const kv of values.var ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new UsageError(`--var expects key=value, got "${kv}"`);
    vars[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const num = (v: string | undefined, flag: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} expects a number, got "${v}"`);
    return n;
  };

  let current = "";
  const rep = await runCollection({
    target, env: values.env, vars, data: values.data, iterations: num(values.iterations, "--iterations"), bail: values.bail,
    delayMs: num(values.delay, "--delay"), timeoutMs: num(values.timeout, "--timeout"), insecure: values.insecure,
    noCookies: values["no-cookies"], proxy: values.proxy, ca: values.ca,
    onNote: (m) => console.log(yellow(`note: ${m}`)),
    onResult: (r) => {
      const dir = path.posix.dirname(r.rel);
      const head = dir === "." ? "" : dir;
      if (head !== current || r.iteration !== 1 && current === "__never__") {
        current = head;
        if (head) console.log(`\n${bold(head + "/")}`);
        else console.log("");
      }
      printResult(r, (values.data !== undefined) || (num(values.iterations, "--iterations") ?? 1) > 1);
    },
  }).catch((e) => {
    throw e;
  });

  const ok = summarize(rep);
  if (values.junit) fs.writeFileSync(values.junit, junitXml(rep));
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(rep, null, 2));
  if (values.html) fs.writeFileSync(values.html, htmlReport(rep));
  return ok ? 0 : 1;
}

if (process.argv[1] && /cairn(\.mjs)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(red(e instanceof UsageError ? e.message : `Error: ${(e as Error).message ?? e}`));
      process.exit(e instanceof UsageError ? 2 : 2);
    },
  );
}
