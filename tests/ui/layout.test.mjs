/**
 * Layout invariants. These run the real app in a real browser (the Chrome that is already installed,
 * no browser download) against a stand-in for Tauri's IPC, and assert things that must ALWAYS hold,
 * whatever the window size, theme, or which panels are open:
 *   - nothing overflows the window sideways, and the page never crashes
 *   - the main area keeps a usable width (never collapses to 0px)
 *   - the controls you need (Send, code/AI toggles, new tab, environment) are visible AND not covered
 *   - chips, tabs and labels never wrap onto a second line
 *   - many tabs scroll inside their strip instead of pushing controls away
 *   - dialogs fit inside the window
 * Run: npm run test:ui
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}/tests/ui/harness.html`;
const SHOTS = path.join(ROOT, "test-results", "ui");
let server;
let browser;

const WIDTHS = [760, 1000, 1180, 1360];
const THEMES = ["dark", "light"];
const STATES = [
  { name: "sidebar open", sidebar: true, aside: null },
  { name: "sidebar closed", sidebar: false, aside: null },
  { name: "code panel", sidebar: true, aside: "code" },
  { name: "AI panel", sidebar: true, aside: "ai" },
  { name: "sidebar closed + code panel", sidebar: false, aside: "code" },
];

/** What the app would get from Tauri: a small collection and canned responses. The response is deliberately a worst case (120 headers, 12 cookies, 1 GB, two minutes) so that wide numbers can't break the header. Runs before the app loads. */
const stubSource = ({ sidebar, aside, bigTree = 0, bigBody = 0, withLink = false, leakyToken = '' }) => `
(() => {
  const req = (n, m) => 'name: ' + n + '\\nmethod: ' + m + '\\nurl: https://api.example.com/' + n + '\\n';
  let files = {
    '/demo/auth/login.req.yaml': req('login', 'POST'),
    '/demo/invoices/list-invoices.req.yaml': req('list-invoices', 'GET'),
    '/demo/invoices/create-invoice.req.yaml': req('create-invoice', 'POST'),
    '/demo/invoices/void-invoice.req.yaml': req('void-invoice', 'DELETE'),
  };
  if (${JSON.stringify(leakyToken)}) files['/demo/auth/leaky.req.yaml'] = 'name: leaky\\nmethod: GET\\nurl: https://api.example.com/x\\nauth:\\n  mode: bearer\\n  token: ' + ${JSON.stringify(leakyToken)} + '\\n';
  if (${withLink}) files['/demo/invoices/login-link.req.yaml'] = 'use: ../auth/login.req.yaml\\n';
  const f = (p) => ({ name: p.split('/').pop(), path: p, isDir: false, children: [] });
  const d = (p, c) => ({ name: p.split('/').pop(), path: p, isDir: true, children: c });
  let tree = [d('/demo/auth', [f('/demo/auth/login.req.yaml')]), d('/demo/invoices', Object.keys(files).filter((k) => k.includes('invoices/')).map(f))];
  const BIG = ${bigTree};
  const BODY_LINES = ${bigBody};
  if (BIG > 0) {
    files = {};
    tree = [];
    for (let k = 0; k < 20; k++) {
      const kids = [];
      for (let i = 0; i < BIG / 20; i++) {
        const p = '/big/f' + k + '/r' + i + '.req.yaml';
        files[p] = req('r' + i, i % 2 ? 'GET' : 'POST');
        kids.push(f(p));
      }
      tree.push(d('/big/f' + k, kids));
    }
  }
  localStorage.setItem('rq.collection', JSON.stringify(BIG > 0 ? { root: '/big', name: 'Big' } : { root: '/demo', name: 'Payments API' }));
  localStorage.setItem('rq.sidebar', ${JSON.stringify(JSON.stringify(sidebar))});
  localStorage.setItem('rq.aside', ${JSON.stringify(JSON.stringify(aside))});
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd, a) => {
      if (BODY_LINES > 0) {
        const lineOf = (n) => n === 0 ? '[' : n === BODY_LINES - 1 ? ']' : ['  {', '    "id": "inv_' + Math.floor((n - 1) / 4) + '",', '    "tag": "Alpha"', '  },'][(n - 1) % 4];
        if (cmd === 'send_request') return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '', bodyBase64: null, bodyId: 7, contentType: 'application/json', sizeBytes: BODY_LINES * 22, timeMs: 640, ttfbMs: 80, httpVersion: 'HTTP/1.1' };
        if (cmd === 'body_prepare') return { lines: BODY_LINES, bytes: BODY_LINES * 22, pretty: true };
        if (cmd === 'body_lines') return Array.from({ length: Math.max(0, Math.min(a.count, BODY_LINES - a.start)) }, (_, i) => lineOf(a.start + i));
        if (cmd === 'body_search') {
          const hits = []; for (let n = 3; n < BODY_LINES - 1; n += 4) hits.push(n);
          return { total: a.query.toLowerCase() === 'alpha' ? hits.length : 0, capped: false, lines: a.query.toLowerCase() === 'alpha' ? hits : [] };
        }
      }
      if (cmd === 'send_request') {
        const body = JSON.stringify({ data: Array.from({ length: 6 }, (_, i) => ({ id: 'inv_' + i, amount: 12900 + i })) });
        return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ...Array.from({ length: 12 }, (_, i) => ['set-cookie', 'sid' + i + '=abc; Path=/; HttpOnly']), ...Array.from({ length: 108 }, (_, i) => ['x-trace-' + i, 'v' + i])], body, bodyBase64: null, contentType: 'application/json', sizeBytes: 1000000000, timeMs: 123456, ttfbMs: 98765, httpVersion: 'HTTP/1.1' };
      }
      if (cmd === 'list_tree') return tree;
      if (cmd === 'read_text') return files[a.path] ?? null;
      if (cmd === 'write_text') { files[a.path] = a.text; return null; }
      if (cmd === 'list_files') return [];
      if (cmd === 'list_files_recursive') return Object.keys(files).filter((p) => p.startsWith(a.dir));
      return null;
    },
  };
})();`;

async function waitForServer(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The dev server did not start on ${url}`);
}

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/** Open the app in a fresh browser context. `fail()` saves a screenshot next to the failing assertion. */
async function open({ width, height = 800, theme = "dark", sidebar = true, aside = null, bigTree = 0, bigBody = 0, withLink = false, leakyToken = "" }, label) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addInitScript(stubSource({ sidebar, aside, bigTree, bigBody, withLink, leakyToken }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector(".urlbar");
  await page.waitForTimeout(250);
  const check = async (fn) => {
    try {
      await fn();
    } catch (e) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
      await page.screenshot({ path: file }).catch(() => {});
      e.message = `${label}\n${e.message}\n(screenshot: ${path.relative(ROOT, file)})`;
      throw e;
    }
  };
  return { page, context, errors, check };
}

/** Runs in the page: measurements of everything the invariants talk about. */
const MEASURE = () => {
  const q = (s) => document.querySelector(s);
  const all = (s) => [...document.querySelectorAll(s)];
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  const visible = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
  /** The control can be clicked: whatever is on top at its centre is the control itself (or part of it). */
  const hittable = (el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (top === el || el.contains(top));
  };
  /** How many text lines an element has: rectangles that overlap vertically belong to the same line. */
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0).sort((a, b) => a.top - b.top);
    let count = 0;
    let bottom = -Infinity;
    for (const r of rects) {
      if (r.top >= bottom - 1) {
        count++;
        bottom = r.bottom;
      } else bottom = Math.max(bottom, r.bottom);
    }
    return count;
  };
  const controls = {
    "Send": q(".urlbar > .btn.primary"),
    "code toggle": all(".urlbar .code-btn")[0],
    "AI toggle": all(".urlbar .code-btn")[1],
    "new tab (+)": q(".tabbar > .icon-btn.plus"),
    "all-tabs menu": q(".tabbar > .menu-wrap > .icon-btn"),
    "environment picker": q(".env-pick"),
    "URL field": q(".url-cell"),
  };
  const sidebarOpen = visible(q(".sidebar"));
  if (sidebarOpen) {
    controls["rail: collections"] = q('.rail button[aria-label="Collections"]');
    controls["rail: settings"] = q('.rail button[aria-label="Settings"]');
  } else controls["show sidebar"] = q(".show-side");
  const state = {};
  for (const [name, el] of Object.entries(controls)) {
    state[name] = el ? { ...rect(el), visible: visible(el), hittable: visible(el) && hittable(el) } : null;
  }
  const wrappers = all(".pill, .m, .tree-method, .subtabs button, .seg button, .btn.primary, .tab-title, .env-pick, .urlbar .btn")
    .filter(visible)
    .filter((el) => lines(el) > 1)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.textContent || "").trim().slice(0, 30)}"`);
  return {
    vw: innerWidth,
    vh: innerHeight,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    crashed: document.body.innerText.includes("hit a problem"),
    app: q(".app")?.className.trim(),
    main: rect(q(".main")),
    sidebar: sidebarOpen ? rect(q(".sidebar")) : null,
    panel: rect(q(".codepanel")),
    panelFixed: q(".codepanel") ? getComputedStyle(q(".codepanel")).position === "fixed" : null,
    tabbar: q(".tabbar") ? { scrollW: q(".tabbar").scrollWidth, clientW: q(".tabbar").clientWidth } : null,
    controls: state,
    wrappers,
  };
};

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    for (const st of STATES) {
      test(`layout holds: ${width}px, ${theme}, ${st.name}`, async () => {
        const label = `${width}px ${theme} ${st.name}`;
        const { page, context, errors, check } = await open({ width, theme, sidebar: st.sidebar, aside: st.aside }, label);
        try {
          const m = await page.evaluate(MEASURE);
          await check(async () => {
            assert.deepEqual(errors, [], "the page threw errors");
            assert.equal(m.crashed, false, "the app crashed (error boundary is showing)");
            assert.equal(m.overflowX, false, "the page overflows sideways");
            assert.ok(m.main && m.main.w >= 380, `the main area is only ${Math.round(m.main?.w ?? 0)}px wide (needs 380+)`);
            assert.ok(m.main.l >= 0 && m.main.r <= m.vw + 1, "the main area sticks out of the window");
            if (st.sidebar) assert.ok(m.sidebar && m.sidebar.w > 100, "the sidebar should be open but is not");
            for (const [name, c] of Object.entries(m.controls)) {
              if (!c) continue;
              assert.ok(c.visible, `${name} is not visible`);
              assert.ok(c.l >= -1 && c.r <= m.vw + 1, `${name} sticks out of the window (${Math.round(c.l)}..${Math.round(c.r)} of ${m.vw})`);
              assert.ok(c.hittable, `${name} is covered by something else and cannot be clicked`);
            }
            assert.ok(m.controls["Send"], "Send button is missing");
            assert.equal(m.wrappers.length, 0, `these labels wrap onto a second line: ${m.wrappers.join(" | ")}`);
            if (m.tabbar) assert.ok(m.tabbar.scrollW <= m.tabbar.clientW + 1, "the tab bar itself overflows (tabs must scroll inside their strip)");
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}

for (const width of [760, 1000, 1360]) {
  test(`many tabs scroll in their strip and keep + and the picker reachable: ${width}px`, async () => {
    const label = `${width}px many tabs`;
    const { page, context, check } = await open({ width }, label);
    try {
      for (let i = 0; i < 18; i++) await page.click(".tabbar > .icon-btn.plus");
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const box = (el) => el.getBoundingClientRect();
        const strip = box(q(".tabstrip"));
        const on = box(q(".tab.on"));
        const bar = box(q(".tabbar"));
        const plus = box(q(".tabbar > .icon-btn.plus"));
        const env = box(q(".env-pick"));
        return {
          tabs: document.querySelectorAll(".tab").length,
          activeInStrip: on.left >= strip.left - 1 && on.right <= strip.right + 1,
          plusInBar: plus.right <= bar.right + 1,
          envInBar: env.right <= bar.right + 1,
        };
      });
      await page.click(".tabbar > .menu-wrap > .icon-btn");
      r.menuItemsAfterOpen = await page.locator(".tabbar .popmenu button").count();
      await check(async () => {
        assert.ok(r.tabs >= 18, `expected 18+ tabs, got ${r.tabs}`);
        assert.ok(r.activeInStrip, "the active tab is scrolled out of view");
        assert.ok(r.plusInBar, "the + button was pushed out of the tab bar");
        assert.ok(r.envInBar, "the environment picker was pushed out of the tab bar");
        assert.equal(r.menuItemsAfterOpen, r.tabs, "the all-tabs menu should list every tab");
      });
    } finally {
      await context.close();
    }
  });
}

// The busiest header: two responses, so the "Latest" picker and Compare sit next to the status chips.
for (const width of [760, 900, 1000, 1100, 1180, 1200, 1360]) {
  for (const aside of [null, "code"]) {
    for (const responses of [1, 2]) {
      test(`a response keeps its header on one line: ${width}px, ${responses} response${responses > 1 ? "s" : ""}${aside ? ", code panel open" : ""}`, async () => {
        const label = `${width}px response header x${responses} ${aside ?? "no panel"}`;
        const { page, context, errors, check } = await open({ width, aside }, label);
        try {
          await page.click(".url-cell");
          await page.keyboard.type("https://api.example.com/v1/slow");
          for (let i = 0; i < responses; i++) {
            await page.click(".urlbar > .btn.primary");
            await page.waitForTimeout(450);
          }
          await page.waitForSelector(".panel.res .pill");
          if (responses > 1) await page.waitForSelector(".panel.res .hist-pick", { state: "attached" });
          const r = await page.evaluate(() => {
            const row = [...document.querySelectorAll(".panel.res .subtabs > *")].filter((el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0);
            const centres = row.map((el) => {
              const b = el.getBoundingClientRect();
              return (b.top + b.bottom) / 2;
            });
            const bar = document.querySelector(".panel.res .subtabs");
            /** Number of text lines: rectangles that overlap vertically are the same line. */
            const lines = (el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0).sort((a, b) => a.top - b.top);
              let count = 0;
              let bottom = -Infinity;
              for (const r of rects) {
                if (r.top >= bottom - 1) {
                  count++;
                  bottom = r.bottom;
                } else bottom = Math.max(bottom, r.bottom);
              }
              return count;
            };
            const wrapped = [...document.querySelectorAll(".panel.res .subtabs .pill, .panel.res .subtabs .meta span, .panel.res .subtabs button")]
              .filter((el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0)
              .filter((el) => lines(el) > 1)
              .map((el) => `"${(el.textContent || "").trim().slice(0, 24)}"`);
            return { oneRow: Math.max(...centres) - Math.min(...centres) < 10, pageOverflow: bar.scrollWidth > bar.clientWidth + 1 && getComputedStyle(bar).overflowX === "visible", wrapped };
          });
          await check(async () => {
            assert.deepEqual(errors, [], "the page threw errors");
            assert.ok(r.oneRow, "the response tabs and status chips are on more than one row");
            assert.equal(r.wrapped.length, 0, `these wrap onto a second line: ${r.wrapped.join(", ")}`);
            assert.equal(r.pageOverflow, false, "the response header is wider than its panel");
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}

for (const width of [760, 1000]) {
  test(`Settings and the command palette fit inside the window: ${width}px`, async () => {
    const label = `${width}px dialogs`;
    const { page, context, check } = await open({ width, height: 640 }, label);
    try {
      await page.click('.rail button[aria-label="Settings"]');
      await page.waitForSelector(".settings");
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => {
        const r = document.querySelector(".settings").getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight };
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+k");
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(300);
      const p = await page.evaluate(() => {
        const el = document.querySelector(".palette");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: r.left, r: r.right, vw: innerWidth };
      });
      await check(async () => {
        assert.ok(s.l >= 0 && s.r <= s.vw + 1 && s.t >= -1 && s.b <= s.vh + 1, `Settings does not fit: ${JSON.stringify(s)}`);
        if (p) assert.ok(p.l >= 0 && p.r <= p.vw + 1, `the command palette does not fit: ${JSON.stringify(p)}`);
      });
    } finally {
      await context.close();
    }
  });
}

test("a 10,000-request collection renders only what is on screen and stays correct", async () => {
  const { page, context, errors, check } = await open({ width: 1360, bigTree: 10000 }, "10k collection");
  try {
    await page.waitForSelector(".tree-row");
    const rows = () => page.locator(".tree-row").count();
    const treeHeight = () => page.evaluate(() => document.querySelector(".tree").getBoundingClientRect().height);
    const first = await rows();
    const total = await treeHeight();
    // scroll to the very end: the last rows must exist, sit at the bottom, and get their method labels
    await page.evaluate(() => { document.querySelector(".side-body").scrollTop = 1e9; });
    await page.waitForFunction(() => [...document.querySelectorAll(".tree-row")].some((r) => r.textContent.includes("r499")));
    await page.waitForFunction(() => [...document.querySelectorAll(".tree-row")].some((r) => r.textContent.includes("r499") && !r.querySelector(".m-none")));
    const atEnd = await page.evaluate(() => {
      const scroller = document.querySelector(".side-body");
      const last = [...document.querySelectorAll(".tree-row")].filter((r) => r.textContent.includes("r499")).pop();
      const lr = last.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      return { lastVisible: lr.top >= sr.top - 1 && lr.bottom <= sr.bottom + 1, method: last.querySelector(".tree-method").textContent, count: document.querySelectorAll(".tree-row").length };
    });
    // collapse and expand the first folder
    await page.evaluate(() => { document.querySelector(".side-body").scrollTop = 0; });
    await page.waitForFunction(() => [...document.querySelectorAll(".tree-row")].some((r) => r.textContent.trim().startsWith("f0")));
    await page.locator(".tree-row", { hasText: "f0" }).first().locator(".tree-label").click();
    await page.waitForTimeout(200);
    const collapsed = await treeHeight();
    await page.locator(".tree-row", { hasText: "f0" }).first().locator(".tree-label").click();
    await page.waitForTimeout(200);
    const expanded = await treeHeight();
    // clicking a request opens it in a tab
    await page.locator(".tree-row", { hasText: "r3" }).first().locator(".tree-label").click();
    await page.waitForTimeout(400);
    const tabTitle = await page.evaluate(() => document.querySelector(".tab.on .tab-title")?.textContent);
    await check(async () => {
      assert.deepEqual(errors, [], "the page threw errors");
      assert.ok(first < 120, `${first} rows are in the DOM at the start (only the window around the viewport should be)`);
      assert.equal(total, 10020 * 28, "the scroll height must still stand for every row");
      assert.ok(atEnd.count < 120, `${atEnd.count} rows are in the DOM after scrolling`);
      assert.ok(atEnd.lastVisible, "the last request is not reachable at the end of the list");
      assert.ok(["GET", "POST"].includes(atEnd.method), `the last row has no method label (got "${atEnd.method}")`);
      assert.equal(collapsed, (10020 - 500) * 28, "collapsing a folder should remove its 500 rows");
      assert.equal(expanded, 10020 * 28, "expanding it again should bring them back");
      assert.equal(tabTitle, "r3", "clicking a request should open it");
    });
  } finally {
    await context.close();
  }
});

test("a 3-million-line response shows only what is on screen, scrolls the whole way and searches", async () => {
  const LINES = 3_000_000;
  const { page, context, errors, check } = await open({ width: 1360, bigBody: LINES }, "big response");
  try {
    await page.click(".url-cell");
    await page.keyboard.type("https://api.example.com/v1/huge");
    await page.click(".urlbar > .btn.primary");
    await page.waitForSelector(".big-line");
    const dom = () => page.locator(".big-line").count();
    const startRows = await dom();
    const label = await page.locator(".big-count").textContent();
    // jump to the very end: the last line must be the closing bracket
    await page.evaluate(() => { document.querySelector(".big-scroll").scrollTop = 1e12; });
    await page.waitForFunction(() => [...document.querySelectorAll(".big-line")].some((l) => l.querySelector(".big-ln").textContent === "3000000"));
    const end = await page.evaluate(() => {
      const scroller = document.querySelector(".big-scroll").getBoundingClientRect();
      const last = [...document.querySelectorAll(".big-line")].find((l) => l.querySelector(".big-ln").textContent === "3000000");
      const r = last.getBoundingClientRect();
      return { text: last.querySelector(".big-tx").textContent.trim(), inside: r.bottom <= scroller.bottom + 1 && r.top >= scroller.top - 1, rows: document.querySelectorAll(".big-line").length, spacer: document.querySelector(".big-spacer").getBoundingClientRect().height };
    });
    // searching jumps to the first match and counts them all
    await page.evaluate(() => { document.querySelector(".big-scroll").scrollTop = 0; });
    await page.locator(".big-q").fill("alpha");
    await page.waitForFunction(() => document.querySelector(".big-count").textContent.startsWith("1 of"));
    const found = await page.locator(".big-count").textContent();
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "big-response.png") });
    const marked = await page.locator(".big-line mark").count();
    await page.locator(".big-q").press("Enter");
    await page.waitForFunction(() => document.querySelector(".big-count").textContent.startsWith("2 of"));
    await page.locator(".big-q").fill("zzz-nothing");
    await page.waitForFunction(() => document.querySelector(".big-count").textContent === "No matches");
    await check(async () => {
      assert.deepEqual(errors, [], "the page threw errors");
      assert.ok(startRows < 80, `${startRows} lines are in the DOM (only the window around the viewport should be)`);
      assert.match(label, /3,000,000 lines/);
      assert.equal(end.text, "]");
      assert.ok(end.inside, "the last line is not fully visible at the end of the scroll");
      assert.ok(end.rows < 80, `${end.rows} lines are in the DOM at the end`);
      assert.ok(end.spacer <= 8_000_000 + 1, `the scroll height (${end.spacer}px) is beyond what browsers can draw`);
      assert.match(found, /^1 of 749,999/);
      assert.ok(marked > 0, "matches are not highlighted");
    });
  } finally {
    await context.close();
  }
});

/**
 * Budgets. These count things (DOM nodes, rendered rows) which are the same on every machine, and only
 * put a very loose ceiling on time (about 5x what a 2020 laptop needs) so slow CI doesn't make them flaky.
 * A regression that renders everything again, or blocks the page, blows through them by a wide margin.
 */
const BUDGET = { domNodes: 4000, treeRows: 120, bigLines: 80, firstPaintMs: 8000, freezeMs: 700 };

test("budget: a 10,000-request collection stays light", async () => {
  const { page, context, errors } = await open({ width: 1360, bigTree: 10000 }, "budget 10k tree");
  try {
    const t0 = Date.now();
    await page.waitForSelector(".tree-row");
    const firstPaint = Date.now() - t0;
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({ nodes: document.getElementsByTagName("*").length, rows: document.querySelectorAll(".tree-row").length }));
    assert.deepEqual(errors, []);
    assert.ok(m.nodes < BUDGET.domNodes, `${m.nodes} DOM nodes (budget ${BUDGET.domNodes})`);
    assert.ok(m.rows < BUDGET.treeRows, `${m.rows} tree rows (budget ${BUDGET.treeRows})`);
    assert.ok(firstPaint < BUDGET.firstPaintMs, `first rows after ${firstPaint} ms (budget ${BUDGET.firstPaintMs})`);
  } finally {
    await context.close();
  }
});

test("budget: opening and scrolling a huge response never blocks the page", async () => {
  const { page, context, errors } = await open({ width: 1360, bigBody: 3_000_000 }, "budget big response");
  try {
    await page.click(".url-cell");
    await page.keyboard.type("https://api.example.com/v1/huge");
    await page.evaluate(() => {
      window.__gap = 0;
      let last = performance.now();
      setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 20);
    });
    const t0 = Date.now();
    await page.click(".urlbar > .btn.primary");
    await page.waitForSelector(".big-line");
    const shown = Date.now() - t0;
    for (const top of [1e5, 5e6, 3e7, 8e6, 0]) {
      await page.evaluate((t) => { document.querySelector(".big-scroll").scrollTop = t; }, top);
      await page.waitForTimeout(120);
    }
    const m = await page.evaluate(() => ({ nodes: document.getElementsByTagName("*").length, lines: document.querySelectorAll(".big-line").length, freeze: Math.round(window.__gap) }));
    assert.deepEqual(errors, []);
    assert.ok(m.nodes < BUDGET.domNodes, `${m.nodes} DOM nodes (budget ${BUDGET.domNodes})`);
    assert.ok(m.lines < BUDGET.bigLines, `${m.lines} response lines in the DOM (budget ${BUDGET.bigLines})`);
    assert.ok(shown < BUDGET.firstPaintMs, `first lines after ${shown} ms (budget ${BUDGET.firstPaintMs})`);
    assert.ok(m.freeze < BUDGET.freezeMs, `the page froze for ${m.freeze} ms (budget ${BUDGET.freezeMs})`);
  } finally {
    await context.close();
  }
});

for (const width of [760, 1360]) {
  test(`hovering a row keeps its name readable and never puts an action under its middle: ${width}px`, async () => {
    const { page, context, check } = await open({ width }, `${width}px tree row hover`);
    try {
      await page.waitForSelector(".tree-row");
      const measure = async (index) => {
        await page.locator(".tree-row").nth(index).hover();
        await page.waitForTimeout(120);
        return page.evaluate((i) => {
          const row = document.querySelectorAll(".tree-row")[i];
          const b = row.getBoundingClientRect();
          const label = row.querySelector(".tree-label").getBoundingClientRect();
          const actions = row.querySelector(".row-actions").getBoundingClientRect();
          const mid = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
          return { rowW: b.width, labelW: label.width, actionsW: actions.width, middleIsAction: !!mid?.closest(".row-actions"), name: row.querySelector(".tree-label").textContent };
        }, index);
      };
      const folder = await measure(0);
      const file = await measure(1);
      await check(async () => {
        for (const [what, m] of [["folder", folder], ["request", file]]) {
          assert.ok(m.labelW >= 60, `hovering a ${what} row squeezes its name "${m.name}" to ${Math.round(m.labelW)}px`);
          assert.ok(m.actionsW <= m.rowW * 0.35, `the action buttons take ${Math.round(m.actionsW)}px of a ${Math.round(m.rowW)}px row`);
          assert.equal(m.middleIsAction, false, `the middle of a ${what} row is an action button, so a normal click would trigger it`);
        }
      });
      await page.locator(".tree-row").first().hover();
      await page.locator(".tree-row").first().locator('button[aria-label^="More actions"]').click();
      await page.waitForSelector(".popmenu");
      const items = await page.locator(".popmenu button").allTextContents();
      await check(async () => {
        for (const wanted of ["New folder", "Run folder", "Folder settings", "Rename", "Delete"]) assert.ok(items.some((t) => t.includes(wanted)), `the row menu has no "${wanted}" (has: ${items.join(", ")})`);
      });
    } finally {
      await context.close();
    }
  });
}

/* ------------------------------ accessibility ------------------------------ */

const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");

/** WCAG 2 A and AA rules from axe-core, on whatever is on screen right now. */
async function axeViolations(page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, where: v.nodes.slice(0, 8).map((n) => n.target.join(" ") + (n.html.length < 160 && v.id === "label" ? ` ${n.html}` : "") + (n.any[0]?.data?.contrastRatio ? ` (${n.any[0].data.contrastRatio}:1 ${n.any[0].data.fgColor} on ${n.any[0].data.bgColor})` : "")) }));
  });
}

const A11Y_STATES = [
  { name: "empty request", go: async () => {} },
  { name: "with a response", go: async (page) => { await page.click(".url-cell"); await page.keyboard.type("https://api.example.com/v1/x"); await page.click(".urlbar > .btn.primary"); await page.waitForSelector(".panel.res .pill"); } },
  { name: "settings", go: async (page) => { await page.click('.rail button[aria-label="Settings"]'); await page.waitForSelector(".settings"); } },
  { name: "command palette", go: async (page) => { await page.keyboard.press("Control+k"); await page.waitForSelector(".palette"); } },
  { name: "code panel", aside: "code", go: async () => {} },
  { name: "AI panel", aside: "ai", go: async () => {} },
];

for (const theme of THEMES) {
  for (const st of A11Y_STATES) {
    test(`accessibility (axe, WCAG A/AA): ${st.name}, ${theme}`, async () => {
      const { page, context, errors } = await open({ width: 1360, theme, aside: st.aside ?? null }, `axe ${st.name} ${theme}`);
      try {
        await st.go(page);
        await page.waitForTimeout(300);
        const v = await axeViolations(page);
        assert.deepEqual(errors, []);
        assert.deepEqual(v.map((x) => `${x.id} [${x.impact}] ${x.help}: ${x.where.join(" | ")}`), [], "accessibility violations");
      } finally {
        await context.close();
      }
    });
  }
}

const REQUEST_TABS = ["Params", "Headers", "Body", "Auth", "Scripts", "Tests", "Examples", "Settings"];
for (const theme of THEMES) {
  for (const width of [760, 1360]) {
    test(`every request tab is accessible and fits: ${width}px, ${theme}`, async () => {
      const { page, context, errors } = await open({ width, theme }, `tabs ${width} ${theme}`);
      try {
        await page.click(".url-cell");
        await page.keyboard.type("https://api.example.com/v1/x");
        await page.waitForSelector(".panel.req .subtabs");
        const found = [];
        for (const name of REQUEST_TABS) {
          await page.locator(".panel.req .subtabs button", { hasText: new RegExp(`^${name}`) }).click();
          await page.waitForTimeout(150);
          const fit = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, pane: (() => { const p = document.querySelector(".panel.req").getBoundingClientRect(); return p.right <= innerWidth + 1 && p.left >= -1; })() }));
          assert.ok(fit.over <= 0 && fit.pane, `${name}: the page overflows sideways (${fit.over}px)`);
          const v = await axeViolations(page);
          found.push(...v.map((x) => `${name}: ${x.id}: ${x.where.join(" | ")}`));
        }
        assert.deepEqual(found, [], "accessibility violations");
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
}

test("keyboard: Settings and the command palette take focus, close on Escape and give it back", async () => {
  const { page, context, errors } = await open({ width: 1360 }, "keyboard dialogs");
  try {
    await page.focus('.rail button[aria-label="Settings"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".settings");
    const inside = await page.evaluate(() => !!document.activeElement?.closest(".settings"));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".settings", { state: "detached" });
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette");
    const paletteFocus = await page.evaluate(() => !!document.activeElement?.closest(".palette"));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".palette", { state: "detached" });
    assert.deepEqual(errors, []);
    assert.ok(inside, "opening Settings with the keyboard should move focus into it");
    assert.ok(paletteFocus, "opening the command palette should focus its search box");
  } finally {
    await context.close();
  }
});

test("keyboard: Tab reaches Send, and every control that takes focus shows a visible focus ring", async () => {
  const { page, context } = await open({ width: 1360 }, "keyboard focus");
  try {
    const seen = [];
    await page.click(".url-cell");
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || !!el.closest(".cm-editor, .tree, .tabstrip");
        return { label: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24) || el.tagName, ring, send: el.matches(".urlbar > .btn.primary") };
      });
      if (f) seen.push(f);
    }
    assert.ok(seen.some((f) => f.send), "Tab never reached the Send button");
    const bare = seen.filter((f) => !f.ring).map((f) => f.label);
    assert.deepEqual(bare, [], `these controls take focus but show no focus ring: ${bare.join(", ")}`);
  } finally {
    await context.close();
  }
});

for (const width of [760, 1360]) {
  test(`response filter: jq and JSONPath narrow the body, errors keep it, and the row fits: ${width}px`, async () => {
    const { page, context, errors, check } = await open({ width }, `${width}px response filter`);
    try {
      await page.click(".url-cell");
      await page.keyboard.type("https://api.example.com/v1/x");
      await page.click(".urlbar > .btn.primary");
      await page.waitForSelector(".filter-input");
      const text = () => page.evaluate(() => [...document.querySelectorAll(".panel.res .cm-line")].map((l) => l.textContent).join("\n"));
      const status = () => page.locator(".filter-row [role=status]").textContent();
      await page.fill(".filter-input", "$.data[*].id");
      await page.waitForSelector(".filter-row [role=status]");
      const jsonpath = { status: await status(), body: await text() };
      await page.fill(".filter-input", ".data | map(.amount) | add");
      await page.waitForTimeout(150);
      const jq = { status: await status(), body: await text() };
      await page.fill(".filter-input", ".data[");
      await page.waitForTimeout(150);
      const broken = { status: await status(), body: await text() };
      await page.fill(".filter-input", "");
      await page.waitForTimeout(150);
      const cleared = await text();
      const fit = await page.evaluate(() => {
        const r = document.querySelector(".filter-row")?.getBoundingClientRect();
        return { over: document.documentElement.scrollWidth - innerWidth, inside: !r || (r.right <= innerWidth + 1 && r.left >= -1) };
      });
      await check(async () => {
        assert.deepEqual(errors, []);
        assert.match(jsonpath.status, /^6 results \(JSONPath\)/);
        assert.ok(jsonpath.body.includes('"inv_0"') && jsonpath.body.includes('"inv_5"') && !jsonpath.body.includes("amount"), `JSONPath output: ${jsonpath.body}`);
        assert.match(jq.status, /^1 result \(jq\)/);
        assert.equal(jq.body.trim(), String(12900 * 6 + 15), "jq output");
        assert.ok(!/results?\b/.test(broken.status ?? "") && broken.status.length > 0, `an invalid filter should say why: ${broken.status}`);
        assert.ok(broken.body.includes('"amount"'), "an invalid filter should keep showing the whole body");
        assert.ok(cleared.includes('"amount"'), "clearing the filter should bring the body back");
        assert.ok(fit.over <= 0 && fit.inside, `the filter row overflows: ${JSON.stringify(fit)}`);
      });
    } finally {
      await context.close();
    }
  });
}

for (const width of [760, 1360]) {
  test(`environments: inheritance and .env import fit and are accessible: ${width}px`, async () => {
    const { page, context, errors, check } = await open({ width }, `${width}px environments`);
    try {
      await page.click('.rail button[aria-label="Environments"]');
      await page.waitForSelector(".side-body .row .btn");
      // the stand-in collection starts with no environments: make two
      await page.getByRole("button", { name: "+ New" }).click();
      await page.getByRole("button", { name: "+ New" }).click();
      await page.waitForSelector('select[aria-label="Inherits from"]');
      await page.selectOption('select[aria-label="Inherits from"]', { index: 1 });
      await page.waitForSelector('.side-body [role="note"]');
      const m = await page.evaluate(() => {
        const side = document.querySelector(".side-body").getBoundingClientRect();
        const row = document.querySelector(".side-body .row");
        const items = [...row.children].map((c) => c.getBoundingClientRect());
        return {
          inside: items.every((r) => r.right <= side.right + 1 && r.left >= side.left - 1),
          // the picker takes the first line; the two buttons share the second
          buttonsTogether: new Set([...row.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1,
          pickerWide: row.querySelector("select").getBoundingClientRect().width >= side.width * 0.6,
          hasImport: [...row.children].some((c) => /Import \.env/.test(c.textContent)),
          over: document.documentElement.scrollWidth - innerWidth,
          note: document.querySelector('.side-body [role="note"]').textContent,
        };
      });
      const v = await axeViolations(page);
      await check(async () => {
        assert.deepEqual(errors, []);
        assert.ok(m.hasImport, "the Import .env button is missing");
        assert.ok(m.inside, "the environment toolbar overflows the sidebar");
        assert.ok(m.buttonsTogether, "the New and Import .env buttons are not on one line");
        assert.ok(m.pickerWide, "the environment picker is squeezed");
        assert.ok(m.over <= 0, "the page overflows sideways");
        assert.match(m.note, /Also gets \d+ variable/);
        assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations");
      });
    } finally {
      await context.close();
    }
  });
}

for (const width of [760, 1360]) {
  test(`linked requests: marker, shared method, banner and menu fit and are accessible: ${width}px`, async () => {
    const { page, context, errors, check } = await open({ width, withLink: true }, `${width}px linked request`);
    try {
      const row = page.locator(".tree-row", { hasText: "login-link" });
      await row.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll(".tree-row")].some((r) => r.textContent.includes("login-link") && r.querySelector(".tree-link") && r.querySelector(".tree-method")?.textContent === "POST"));
      await row.locator(".tree-label").click();
      await page.waitForSelector(".link-note");
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const n = document.querySelector(".link-note").getBoundingClientRect();
        const pr = document.querySelector(".panel.req").getBoundingClientRect();
        const btn = document.querySelector(".link-note button").getBoundingClientRect();
        return { title: document.querySelector(".tab.on .tab-title")?.textContent, inside: n.left >= pr.left - 1 && n.right <= pr.right + 1 && btn.right <= pr.right + 1, oneLine: n.height < 48, over: document.documentElement.scrollWidth - innerWidth, text: document.querySelector(".link-note").textContent };
      });
      await row.hover();
      await row.locator('button[aria-label^="More actions"]').click();
      const items = await page.locator('[role="menuitem"]').allTextContents();
      await page.keyboard.press("Escape");
      const v = await axeViolations(page);
      await check(async () => {
        assert.deepEqual(errors, []);
        assert.equal(m.title, "login", "a linked request opens with the shared request's name");
        assert.match(m.text, /edits change the shared request/);
        assert.ok(m.inside && m.oneLine, `the link note does not fit: ${JSON.stringify(m)}`);
        assert.ok(m.over <= 0, "the page overflows sideways");
        assert.ok(items.some((t) => /Make a separate copy/.test(t)), `the row menu should offer to make a copy: ${items.join(" | ")}`);
        assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations");
      });
    } finally {
      await context.close();
    }
  });
}

test("tabs: preview tab, keep open, reorder by drag, context menu, reopen closed", async () => {
  const { page, context, errors, check } = await open({ width: 1360 }, "tab behaviour");
  try {
    const tabs = () => page.evaluate(() => [...document.querySelectorAll(".tabstrip .tab")].map((t) => ({ title: t.querySelector(".tab-title").textContent, preview: t.classList.contains("preview") })));
    const label = (name) => page.locator(".tree-row", { hasText: name }).first().locator(".tree-label");
    await label("login").click();
    await page.waitForTimeout(300);
    const a = await tabs();
    await label("list-invoices").click();
    await page.waitForTimeout(300);
    const b = await tabs();
    await label("create-invoice").dblclick();
    await page.waitForTimeout(300);
    const c = await tabs();
    await label("login").click();
    await page.waitForTimeout(300);
    const d = await tabs();
    // editing the preview tab keeps it
    await page.click(".url-cell");
    await page.keyboard.type("/x");
    await page.waitForTimeout(400);
    const e = await tabs();
    // drag the last tab onto the first
    const before = (await tabs()).map((t) => t.title);
    await page.locator(".tabstrip .tab").nth(before.length - 1).dragTo(page.locator(".tabstrip .tab").first());
    await page.waitForTimeout(250);
    const moved = (await tabs()).map((t) => t.title);
    // context menu
    await page.locator(".tabstrip .tab").nth(1).click({ button: "right" });
    await page.waitForSelector('[role="menu"][aria-label="Tab actions"]');
    const menu = await page.locator('[role="menu"][aria-label="Tab actions"] [role="menuitem"]').allTextContents();
    const focusInMenu = await page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'));
    const v = await axeViolations(page);
    await page.locator('[role="menuitem"]', { hasText: "Close others" }).click();
    await page.waitForTimeout(250);
    const afterOthers = await tabs();
    // close then reopen with the keyboard
    await page.keyboard.press("Control+w");
    await page.waitForTimeout(250);
    await page.keyboard.press("Control+Shift+t");
    await page.waitForTimeout(250);
    const reopened = await tabs();
    await check(async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(a.map((t) => [t.title, t.preview]), [["New request", false], ["login", true]], "a single click opens a preview tab");
      assert.deepEqual(b.map((t) => [t.title, t.preview]), [["New request", false], ["list-invoices", true]], "the next single click replaces the preview tab");
      assert.deepEqual(c.map((t) => [t.title, t.preview]), [["New request", false], ["create-invoice", false]], "a double click keeps the tab open");
      assert.deepEqual(d.map((t) => [t.title, t.preview]), [["New request", false], ["create-invoice", false], ["login", true]], "a new preview opens next to the kept tab");
      assert.equal(e[2].preview, false, "editing a preview tab keeps it open");
      assert.equal(moved[0], before[before.length - 1], `dragging a tab onto another should move it there: ${before} -> ${moved}`);
      assert.ok(["Close", "Close others", "Close tabs to the right", "Duplicate", "Move left", "Move right"].every((t) => menu.some((m) => m.startsWith(t))), `tab menu: ${menu.join(" | ")}`);
      assert.ok(focusInMenu, "the tab menu should take keyboard focus");
      assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations with the menu open");
      assert.equal(afterOthers.length, 1, "Close others should leave one tab");
      assert.equal(reopened.length, 2, "closing the last tab leaves a fresh one, and reopening brings the closed one back next to it");
      assert.ok(reopened.some((t) => t.title === afterOthers[0].title), `the closed tab should come back: ${JSON.stringify(reopened)}`);
    });
  } finally {
    await context.close();
  }
});

for (const width of [760, 1360]) {
  test(`secret scan: finds a leaked token, shows it masked, moves it into a secret variable: ${width}px`, async () => {
    // built at run time so this file holds no token-shaped string
    const token = "gh" + "p_" + "a1B2c3D4".repeat(5);
    const { page, context, errors, check } = await open({ width, leakyToken: token }, `${width}px secret scan`);
    try {
      await page.hover(".side-title, .side-head, .side-body");
      await page.locator('button[aria-label="More collection actions"]').first().click({ force: true });
      const menuItems = await page.getByRole("menuitem").allTextContents();
      await page.getByRole("menuitem", { name: /Scan for secrets/ }).click();
      await page.waitForSelector(".dialog.scan .scan-row");
      const first = await page.evaluate((t) => {
        const d = document.querySelector(".dialog.scan");
        const r = d.getBoundingClientRect();
        return { text: d.textContent, leaks: d.textContent.includes(t) || document.body.innerHTML.includes(t), fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, rows: d.querySelectorAll(".scan-row").length, kind: d.querySelector(".scan-kind").textContent };
      }, token);
      await page.waitForTimeout(500); // let the dialog finish fading in before measuring colours
      const v = await axeViolations(page);
      await page.getByRole("button", { name: "Move to secret" }).click();
      await page.waitForFunction(() => document.querySelector(".dialog.scan .scan-ok"));
      const after = await page.locator(".dialog.scan").textContent();
      await page.keyboard.press("Escape");
      await page.waitForSelector(".dialog.scan", { state: "detached" });
      await page.click('.rail button[aria-label="Environments"]');
      await page.waitForSelector(".side-body .row");
      const envText = await page.evaluate(() => [...document.querySelectorAll(".side-body input, .side-body select")].map((e) => e.value).join(" | "));
      await check(async () => {
        assert.deepEqual(errors, []);
        assert.ok(menuItems.some((t) => /Export OpenAPI/.test(t)), `the collection menu should offer Export OpenAPI: ${menuItems.join(" | ")}`);
        assert.equal(first.rows, 1, `one finding expected: ${first.text}`);
        assert.match(first.kind, /GitHub token/);
        assert.ok(!first.leaks, "the scan dialog (or the page) must never show the whole secret");
        assert.ok(first.fits, "the scan dialog does not fit the window");
        assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations");
        assert.match(after, /No secrets found/);
        assert.ok(envText.includes("Local") && envText.includes("token"), `the secret should now live in an environment: ${envText}`);
      });
    } finally {
      await context.close();
    }
  });
}

test("import: the HAR option is offered, and the choice dialog is accessible", async () => {
  const { page, context, errors, check } = await open({ width: 1360 }, "import choices");
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette");
    await page.keyboard.type("Import OpenAPI, Postman");
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]:not(.palette)');
    await page.waitForTimeout(500);
    const text = await page.locator('[role="dialog"]:not(.palette)').first().textContent();
    const v = await axeViolations(page);
    await check(async () => {
      assert.deepEqual(errors, []);
      assert.match(text, /HAR recording/);
      assert.match(text, /Postman/);
      assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations");
    });
  } finally {
    await context.close();
  }
});

test("import from clipboard: preview first, then import; wrong content says why; accessible", async () => {
  const { page, context, errors, check } = await open({ width: 1360 }, "paste import");
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette");
    await page.keyboard.type("openapi from clipboard");
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".dialog.paste");
    await page.waitForTimeout(500);
    const importBtn = page.getByRole("button", { name: "Import", exact: true });
    const start = { disabled: await importBtn.isDisabled() };
    await page.fill(".paste-box", "just some words");
    await page.waitForTimeout(450);
    const wrong = { text: await page.locator(".paste-status").textContent(), disabled: await importBtn.isDisabled() };
    await page.fill(".paste-box", JSON.stringify({ info: { name: "c" }, item: [] }));
    await page.waitForTimeout(450);
    const postman = await page.locator(".paste-status").textContent();
    const spec = JSON.stringify({ openapi: "3.0.3", info: { title: "Pets", version: "1" }, servers: [{ url: "https://pets.example" }], paths: { "/pets": { get: { summary: "List pets", responses: { 200: { description: "ok" } } }, post: { summary: "Add pet", responses: { 201: { description: "ok" } } } } } });
    await page.fill(".paste-box", spec);
    await page.waitForTimeout(450);
    const good = { text: await page.locator(".paste-status").textContent(), disabled: await importBtn.isDisabled(), fits: await page.evaluate(() => { const r = document.querySelector(".dialog.paste").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }) };
    const v = await axeViolations(page);
    await page.fill(".paste-box", "https://pets.example/openapi.json");
    await page.waitForTimeout(450);
    const link = await page.locator(".paste-status").textContent();
    await page.fill(".paste-box", spec);
    await page.waitForTimeout(450);
    await importBtn.click();
    await page.waitForSelector(".dialog.paste", { state: "detached" });
    await page.waitForFunction(() => /imported/i.test(document.body.textContent));
    const done = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? "");
    await check(async () => {
      assert.deepEqual(errors, []);
      assert.ok(start.disabled, "Import should be disabled until something valid is pasted");
      assert.match(wrong.text, /isn't an OpenAPI/);
      assert.ok(wrong.disabled);
      assert.match(postman, /Postman collection/);
      assert.match(good.text, /Pets/);
      assert.match(good.text, /2 requests/);
      assert.match(good.text, /GET \/pets/);
      assert.ok(!good.disabled, "a valid spec can be imported");
      assert.ok(good.fits, "the dialog does not fit the window");
      assert.deepEqual(v.map((x) => `${x.id}: ${x.where.join(" | ")}`), [], "accessibility violations");
      assert.match(link, /That's a link/);
      assert.match(done, /Created 2/);
    });
  } finally {
    await context.close();
  }
});
