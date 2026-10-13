/**
 * UI benchmark: how the real interface behaves with a huge collection and huge responses.
 * It runs the app in the installed Chrome against a stand-in for Tauri's IPC, so it measures rendering and
 * main-thread work, NOT native file or network I/O (those only add time). Numbers depend on the machine:
 * compare runs on the same machine, and always report the hardware with them.
 *
 * Run: npm run bench:ui
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 4182;
const URL = `http://127.0.0.1:${PORT}/tests/ui/harness.html`;
const server = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(URL)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
const initScript = ({ files, mb }) => `
(() => {
  const N = ${files};
  const tree = []; const texts = {};
  for (let d = 0; d < 20; d++) {
    const children = [];
    for (let i = 0; i < N / 20; i++) { const p = '/big/f' + d + '/r' + i + '.req.yaml'; texts[p] = 'name: r' + i + '\\nmethod: ' + (i % 2 ? 'GET' : 'POST') + '\\nurl: https://x.io/' + d + '/' + i + '\\n'; children.push({ name: 'r' + i + '.req.yaml', path: p, isDir: false, children: [] }); }
    tree.push({ name: 'f' + d, path: '/big/f' + d, isDir: true, children });
  }
  localStorage.setItem('rq.collection', JSON.stringify({ root: '/big', name: 'Big' }));
  localStorage.setItem('rq.aside', 'null');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let body = null;
  const makeBody = () => { const row = JSON.stringify({ id: 'inv_000000', status: 'open', amount: 12900, currency: 'usd', customer: { id: 'cus_1', email: 'user@example.com' }, tags: ['a','b','c'] }); const n = Math.floor(${mb} * 1024 * 1024 / (row.length + 1)); return '[' + Array(n).fill(row).join(',') + ']'; };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (cmd, a) => {
    if (cmd === 'send_request') { body ??= makeBody(); return { status: 200, statusText: 'OK', headers: [['content-type','application/json']], body, bodyBase64: null, contentType: 'application/json', sizeBytes: body.length, timeMs: 100, ttfbMs: 50, httpVersion: 'HTTP/1.1' }; }
    if (cmd === 'list_tree') return tree; if (cmd === 'read_text') return texts[a.path] ?? null;
    if (cmd === 'list_files' || cmd === 'list_files_recursive') return []; return null; } };
})();`;
const browser = await chromium.launch({ channel: "chrome" });

// 1) a 10,000-request collection
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 800 }, colorScheme: "dark" });
  await ctx.addInitScript(initScript({ files: 10000, mb: 1 }));
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(URL);
  await page.waitForSelector(".tree-row");
  const firstRows = Date.now() - t0;
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => ({ rows: document.querySelectorAll(".tree-row").length, dom: document.getElementsByTagName("*").length, labelled: document.querySelectorAll(".tree-method:not(.m-none)").length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) }));
  // how long does one scroll + one click take on that tree?
  const t1 = Date.now();
  await page.evaluate(() => { document.querySelector(".side-body").scrollTop = 99999; });
  await page.waitForTimeout(50);
  console.log("10k collection:", JSON.stringify({ firstRowsMs: firstRows, ...m, scrollMs: Date.now() - t1 }));
  await ctx.close();
}
// 2) a 50 MB response
for (const mb of [5, 50]) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 800 }, colorScheme: "dark" });
  await ctx.addInitScript(initScript({ files: 200, mb }));
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForSelector(".urlbar");
  await page.click(".url-cell"); await page.keyboard.type("https://x.io/big");
  await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 20); });
  const t0 = Date.now();
  await page.click(".urlbar > .btn.primary");
  let ok = true;
  try { await page.waitForSelector(".panel.res .cm-content .cm-line", { timeout: 90000 }); } catch { ok = false; }
  const shown = Date.now() - t0;
  const m = await page.evaluate(() => ({ longestFreezeMs: Math.round(window.__gap), lines: document.querySelectorAll(".panel.res .cm-line").length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) }));
  console.log(`${mb} MB response:`, JSON.stringify({ shown: ok, msToFirstLines: shown, ...m }));
  await ctx.close();
}
await browser.close();
server.kill();
