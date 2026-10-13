import type { ResponseData, TestResult } from "./types";
import { PM_SHIM } from "./pm";

export type ScriptRequest = { method: string; url: string; headers: [string, string][]; body?: string };
export type ScriptContext = {
  req: ScriptRequest;
  res?: ResponseData;
  /** Effective variables (environment + session) the script can read. */
  vars: Record<string, string>;
};
export type ScriptResult = {
  req: ScriptRequest;
  set: Record<string, string>;
  logs: string[];
  tests: TestResult[];
  error?: string;
};

/**
 * Scripts run in a Web Worker: no DOM, no access to the app or to Tauri's IPC, killed after a
 * timeout. A collection from someone else can't reach your files or secrets through a script.
 */
export const HARNESS = `
${PM_SHIM}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fmt = (a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function expect(actual) {
  const fail = (m) => { throw new Error(m); };
  const mk = (neg) => {
    const chk = (ok, msg) => { if (neg ? ok : !ok) fail((neg ? 'expected NOT: ' : 'expected: ') + msg + ' (got ' + fmt(actual) + ')'); };
    return {
      toBe: (e) => chk(Object.is(actual, e), 'to be ' + fmt(e)),
      toEqual: (e) => chk(eq(actual, e), 'to equal ' + fmt(e)),
      toBeTruthy: () => chk(!!actual, 'to be truthy'),
      toBeFalsy: () => chk(!actual, 'to be falsy'),
      toExist: () => chk(actual !== undefined && actual !== null, 'to exist'),
      toContain: (e) => chk(typeof actual === 'string' ? actual.includes(e) : Array.isArray(actual) && actual.some((x) => eq(x, e)), 'to contain ' + fmt(e)),
      toMatch: (re) => chk(new RegExp(re).test(String(actual)), 'to match ' + re),
      toBeGreaterThan: (n) => chk(actual > n, 'to be > ' + n),
      toBeLessThan: (n) => chk(actual < n, 'to be < ' + n),
      toHaveProperty: (k) => chk(actual != null && Object.prototype.hasOwnProperty.call(actual, k), 'to have property ' + k),
    };
  };
  const o = mk(false); o.not = mk(true); return o;
}
self.onmessage = async (e) => {
  const { code, ctx } = e.data;
  const logs = [], tests = [], set = {};
  const req = ctx.req;
  const vars = { ...ctx.vars };
  const env = {
    get: (k) => vars[k],
    set: (k, v) => { vars[k] = String(v); set[k] = String(v); },
  };
  let res;
  if (ctx.res) {
    const r = ctx.res;
    res = { status: r.status, statusText: r.statusText, headers: r.headers, body: r.body, time: r.timeMs, size: r.sizeBytes,
      json: () => JSON.parse(r.body), text: () => r.body,
      header: (n) => { const h = r.headers.find(([k]) => k.toLowerCase() === String(n).toLowerCase()); return h ? h[1] : undefined; } };
  }
  const reqApi = Object.assign(req, {
    setHeader(k, v) { const i = req.headers.findIndex(([x]) => x.toLowerCase() === k.toLowerCase()); i >= 0 ? (req.headers[i] = [k, String(v)]) : req.headers.push([k, String(v)]); },
    removeHeader(k) { req.headers = req.headers.filter(([x]) => x.toLowerCase() !== k.toLowerCase()); },
    getHeader(k) { const h = req.headers.find(([x]) => x.toLowerCase() === k.toLowerCase()); return h && h[1]; },
  });
  const pending = [];
  const test = (name, fn) => {
    const p = (async () => { try { await fn(); tests.push({ name, passed: true }); } catch (err) { tests.push({ name, passed: false, error: String(err && err.message || err) }); } })();
    pending.push(p);
  };
  const log = (...a) => logs.push(a.map(fmt).join(' '));
  let error;
  try {
    const compat = buildPm({ req: reqApi, res, vars, env, test });
    await new AsyncFunction('req', 'res', 'env', 'test', 'expect', 'console', 'pm', 'postman', 'tests', 'responseBody', 'responseCode', 'require', code)(
      reqApi, res, env, test, expect, { log, info: log, warn: log, error: log },
      compat.pm, compat.postman, compat.legacyTests, compat.responseBody, compat.responseCode, compat.requireStub);
    await Promise.all(pending);
    for (const [name, v] of Object.entries(compat.legacyTests)) tests.push({ name, passed: !!v, error: v ? undefined : 'assertion was false' });
  } catch (err) { error = String(err && err.stack ? err.message : err); }
  const { setHeader, removeHeader, getHeader, ...plain } = req;
  postMessage({ req: plain, set, logs, tests, error });
};
`;

let workerUrl: string | null = null;

export function runScript(code: string, ctx: ScriptContext, timeoutMs = 5000): Promise<ScriptResult> {
  workerUrl ??= URL.createObjectURL(new Blob([HARNESS], { type: "text/javascript" }));
  return new Promise((resolve) => {
    const w = new Worker(workerUrl!);
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ req: ctx.req, set: {}, logs: [], tests: [], error: `Script timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve(e.data as ScriptResult);
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve({ req: ctx.req, set: {}, logs: [], tests: [], error: e.message || "Script failed to run" });
    };
    w.postMessage({ code, ctx });
  });
}
