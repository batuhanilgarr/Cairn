import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { executeRequest } from "../../src/lib/pipeline";
import { setNetwork } from "../../src/lib/net";
import { atLeast, formatFindings, scanDirectory, SEVERITIES } from "./scan";
import { effectiveEnv, linkTarget, loadChain, loadEnvironments, parseRequest, readCollectionName } from "../../src/lib/collection";
import { listFilesRecursive } from "../../src/lib/fs";
import type { Environment, RequestTab, TestResult } from "../../src/lib/types";
import type { Layer } from "../../src/lib/inherit";
import { junitXml, htmlReport, type Report, type ReqResult } from "./reporters";

export const VERSION = "0.2.5";

const HELP = `cairn ${VERSION}: run Cairn collections from the command line

Usage
  cairn run <collection | folder | request.req.yaml> [options]
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

export async function runCollection(o: RunOptions): Promise<Report> {
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

  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("CAIRN_VAR_") && v !== undefined) base[k.slice("CAIRN_VAR_".length)] = v;
  Object.assign(base, o.vars ?? {});

  setNetwork({
    proxyMode: o.proxy ? "custom" : "env",
    proxyUrl: o.proxy ?? "",
    caCert: o.ca ?? "",
    cookiesDisabled: !!o.noCookies,
  });

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
      "fail-on": { type: "string" }, format: { type: "string" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(VERSION), 0;
  const [cmd, target] = positionals;
  if (values.help || !cmd) return console.log(HELP), cmd || values.help ? 0 : 2;
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
  if (cmd !== "run") throw new UsageError(`Unknown command "${cmd}". Try: cairn run <collection> or cairn scan <collection>`);
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
