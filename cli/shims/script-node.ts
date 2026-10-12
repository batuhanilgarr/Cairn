import { Worker } from "node:worker_threads";
import { HARNESS, type ScriptContext, type ScriptResult } from "../../src/lib/script";

/**
 * Same script API as the app, run in a worker thread with a time limit.
 * Unlike the app, a Node worker is not a security sandbox: CLI scripts are as trusted as your CI config.
 */
const PRELUDE = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
parentPort.on('message', (d) => globalThis.onmessage({ data: d }));
`;

export function runScript(code: string, ctx: ScriptContext, timeoutMs = 5000): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const w = new Worker(PRELUDE + HARNESS, { eval: true });
    const done = (r: ScriptResult) => {
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ req: ctx.req, set: {}, logs: [], tests: [], error: `Script timed out after ${timeoutMs / 1000}s` }), timeoutMs);
    w.on("message", (m) => done(m as ScriptResult));
    w.on("error", (e) => done({ req: ctx.req, set: {}, logs: [], tests: [], error: e.message }));
    w.postMessage({ code, ctx });
  });
}
