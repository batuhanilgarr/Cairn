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
const stubSource = ({ sidebar, aside }) => `
(() => {
  const req = (n, m) => 'name: ' + n + '\\nmethod: ' + m + '\\nurl: https://api.example.com/' + n + '\\n';
  const files = {
    '/demo/auth/login.req.yaml': req('login', 'POST'),
    '/demo/invoices/list-invoices.req.yaml': req('list-invoices', 'GET'),
    '/demo/invoices/create-invoice.req.yaml': req('create-invoice', 'POST'),
    '/demo/invoices/void-invoice.req.yaml': req('void-invoice', 'DELETE'),
  };
  const f = (p) => ({ name: p.split('/').pop(), path: p, isDir: false, children: [] });
  const d = (p, c) => ({ name: p.split('/').pop(), path: p, isDir: true, children: c });
  const tree = [d('/demo/auth', [f('/demo/auth/login.req.yaml')]), d('/demo/invoices', Object.keys(files).filter((k) => k.includes('invoices/')).map(f))];
  localStorage.setItem('rq.collection', JSON.stringify({ root: '/demo', name: 'Payments API' }));
  localStorage.setItem('rq.sidebar', ${JSON.stringify(JSON.stringify(sidebar))});
  localStorage.setItem('rq.aside', ${JSON.stringify(JSON.stringify(aside))});
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd, a) => {
      if (cmd === 'send_request') {
        const body = JSON.stringify({ data: Array.from({ length: 6 }, (_, i) => ({ id: 'inv_' + i, amount: 12900 + i })) });
        return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ...Array.from({ length: 12 }, (_, i) => ['set-cookie', 'sid' + i + '=abc; Path=/; HttpOnly']), ...Array.from({ length: 108 }, (_, i) => ['x-trace-' + i, 'v' + i])], body, bodyBase64: null, contentType: 'application/json', sizeBytes: 1000000000, timeMs: 123456, ttfbMs: 98765, httpVersion: 'HTTP/1.1' };
      }
      if (cmd === 'list_tree') return tree;
      if (cmd === 'read_text') return files[a.path] ?? null;
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
async function open({ width, height = 800, theme = "dark", sidebar = true, aside = null }, label) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addInitScript(stubSource({ sidebar, aside }));
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
