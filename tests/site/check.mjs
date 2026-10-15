/**
 * Checks for the marketing website (website/). Dependency-free: node + playwright-core + axe-core, which the repo already has.
 * It serves website/ itself on a local port (default 4350, override with SITE_PORT), opens every page in the installed Chrome and checks:
 *   - SEO basics: title and description length, lang, canonical, robots, Open Graph and Twitter tags, JSON-LD parses,
 *     FAQPage matches the visible FAQ, sitemap URLs exist, robots.txt names the sitemap, the base URL is the one in website/site.json
 *   - structure: one h1, headings never skip a level, one main landmark, images have alt and width/height
 *   - links: every href/src/srcset on every page resolves (status 200) and every #fragment exists; no request leaves localhost
 *   - layout: no horizontal overflow at 320/390/768/1280, light and dark, mobile menu opens and closes
 *   - accessibility: axe-core (WCAG 2 A/AA) on every page, light and dark, and with the mobile menu open
 * It also writes screenshots to test-results/site/ so a human can look at them.
 * Run: npm run test:site
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startSiteServer } from "../../scripts/serve-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = path.join(ROOT, "website");
const SHOTS = path.join(ROOT, "test-results", "site");
const PORT = Number(process.env.SITE_PORT || 4350);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = JSON.parse(fs.readFileSync(path.join(SITE, "site.json"), "utf8")).url;
const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");

const problems = [];
const fail = (where, msg) => {
  const m = `${where}: ${msg}`;
  if (!problems.includes(m)) problems.push(m);
};
const note = (msg) => console.log(msg);

/* ---------- the same server `npm run site:serve` runs: GitHub Pages behaviour, 404.html for unknown paths ---------- */
const server = await startSiteServer(PORT);

/* ---------- which pages ---------- */
const sitemap = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const pages = locs.map((u) => {
  if (!u.startsWith(BASE)) fail("sitemap.xml", `${u} does not start with the base URL ${BASE}`);
  return u.slice(BASE.length);
});
for (const p of pages) {
  const f = path.join(SITE, p, p === "" || p.endsWith("/") ? "index.html" : "");
  if (!fs.existsSync(f)) fail("sitemap.xml", `${p || "/"} has no file`);
}
const robots = fs.readFileSync(path.join(SITE, "robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${BASE}sitemap.xml`)) fail("robots.txt", "no Sitemap line with the base URL");
const manifest = JSON.parse(fs.readFileSync(path.join(SITE, "site.webmanifest"), "utf8"));
for (const i of manifest.icons) if (!fs.existsSync(path.join(SITE, i.src))) fail("site.webmanifest", `icon ${i.src} missing`);
for (const f of fs.readdirSync(path.join(SITE, "schema/v1"))) {
  try {
    JSON.parse(fs.readFileSync(path.join(SITE, "schema/v1", f), "utf8"));
  } catch (e) {
    fail(`schema/v1/${f}`, "is not valid JSON");
  }
}
const allPages = [...pages.map((p) => ({ p, url: `${ORIGIN}/${p}` })), { p: "404.html", url: `${ORIGIN}/404.html` }];

const browser = await chromium.launch({ channel: "chrome" });
const external = new Set();
const checkedLinks = new Map();

/** Runs in the page. Everything that can be decided from the DOM alone. */
const INSPECT = () => {
  const q = (s) => [...document.querySelectorAll(s)];
  const meta = (n, a = "name") => document.querySelector(`meta[${a}="${n}"]`)?.getAttribute("content") ?? null;
  const headings = q("h1,h2,h3,h4,h5,h6").map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 50) }));
  return {
    title: document.title,
    description: meta("description"),
    lang: document.documentElement.lang,
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
    robots: meta("robots"),
    viewport: meta("viewport"),
    colorScheme: meta("color-scheme"),
    themeColor: q('meta[name="theme-color"]').length,
    og: Object.fromEntries(["og:title", "og:description", "og:image", "og:url", "og:type", "og:image:alt"].map((k) => [k, meta(k, "property")])),
    tw: Object.fromEntries(["twitter:card", "twitter:title", "twitter:description", "twitter:image"].map((k) => [k, meta(k)])),
    headings,
    mains: q("main").length,
    landmarks: { header: q("header").length, nav: q("nav").length, footer: q("footer").length },
    imgs: q("img").map((i) => ({ src: i.getAttribute("src"), alt: i.getAttribute("alt"), w: i.getAttribute("width"), h: i.getAttribute("height") })),
    jsonld: q('script[type="application/ld+json"]').map((s) => s.textContent),
    faq: q("#faq details").map((d) => ({ q: d.querySelector("summary").textContent.trim(), a: [...d.children].filter((c) => c.tagName !== "SUMMARY").map((c) => c.textContent).join(" ").replace(/\s+/g, " ").trim() })),
    refs: [
      ...q("a[href]").map((e) => ["a", e.getAttribute("href"), e.textContent.trim() || e.getAttribute("aria-label") || ""]),
      ...q('link[href]:not([rel="canonical"])').map((e) => ["link", e.getAttribute("href"), ""]),
      ...q("script[src]").map((e) => ["script", e.getAttribute("src"), ""]),
      ...q("img[src]").map((e) => ["img", e.getAttribute("src"), ""]),
      ...q("source[srcset]").map((e) => ["source", e.getAttribute("srcset"), ""]),
    ].map(([kind, ref, text]) => ({ kind, ref, text, abs: new URL(ref.split(" ")[0], document.baseURI).href })),
    emptyLinks: q("a[href]").filter((a) => !(a.textContent.trim() || a.getAttribute("aria-label") || a.querySelector("img[alt]:not([alt=''])"))).length,
  };
};

async function checkRefs(where, refs) {
  for (const r of refs) {
    let u;
    try {
      u = new URL(r.abs);
    } catch {
      fail(where, `bad URL ${r.ref}`);
      continue;
    }
    if (u.origin !== ORIGIN) {
      if (r.kind !== "a") fail(where, `${r.kind} loads from another origin: ${r.ref}`);
      else external.add(u.href);
      if (r.kind === "a" && /^https?:/.test(r.ref) && u.origin !== ORIGIN && !/^https:\/\//.test(r.ref)) fail(where, `insecure link ${r.ref}`);
      if (r.kind === "a" && /^\s*(link|here|click here|read more)\s*$/i.test(r.text)) fail(where, `non-descriptive link text "${r.text}"`);
      continue;
    }
    if (r.kind === "a" && /^\s*(link|here|click here|read more)\s*$/i.test(r.text)) fail(where, `non-descriptive link text "${r.text}"`);
    const key = u.pathname;
    if (!checkedLinks.has(key)) {
      const res = await fetch(ORIGIN + key);
      checkedLinks.set(key, { status: res.status, body: /html/.test(res.headers.get("content-type") || "") ? await res.text() : "" });
    }
    const hit = checkedLinks.get(key);
    if (hit.status !== 200) fail(where, `${r.kind} ${r.ref} -> ${hit.status}`);
    else if (u.hash && hit.body && !new RegExp(`id="${decodeURIComponent(u.hash.slice(1))}"`).test(hit.body)) fail(where, `${r.ref}: no element with id "${u.hash.slice(1)}"`);
  }
}

for (const { p, url } of allPages) {
  const where = p || "index";
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("request", (r) => {
    if (!r.url().startsWith(ORIGIN) && !r.url().startsWith("data:")) fail(where, `a request left localhost: ${r.url()}`);
  });
  page.on("pageerror", (e) => fail(where, `page error: ${e}`));
  const resp = await page.goto(url);
  if (p === "404.html" ? resp.status() !== 200 : resp.status() !== 200) fail(where, `status ${resp.status()}`);
  const d = await page.evaluate(INSPECT);

  // SEO
  if (!d.title || d.title.length > 60) fail(where, `title is ${d.title?.length} chars: "${d.title}"`);
  if (!d.description || d.description.length < 70 || d.description.length > 160) fail(where, `description is ${d.description?.length} chars`);
  if (d.lang !== "en") fail(where, `lang is "${d.lang}"`);
  if (!d.viewport?.includes("width=device-width")) fail(where, "no responsive viewport");
  if (!d.colorScheme || d.themeColor < 1) fail(where, "missing color-scheme or theme-color");
  const expectCanonical = BASE + (p === "404.html" ? "404.html" : p);
  if (d.canonical !== expectCanonical) fail(where, `canonical is ${d.canonical}, expected ${expectCanonical}`);
  if (p === "404.html" ? !/noindex/.test(d.robots) : /noindex/.test(d.robots)) fail(where, `robots meta is "${d.robots}"`);
  for (const [k, v] of Object.entries({ ...d.og, ...d.tw })) if (!v) fail(where, `missing ${k}`);
  if (d.og["og:image"] && !d.og["og:image"].startsWith(BASE)) fail(where, "og:image is not an absolute URL under the base URL");
  if (d.og["og:url"] !== expectCanonical) fail(where, "og:url differs from canonical");
  if (d.og["og:title"] !== d.title) fail(where, "og:title differs from <title>");
  if (d.og["og:image"]) {
    const f = path.join(SITE, d.og["og:image"].slice(BASE.length));
    if (!fs.existsSync(f)) fail(where, "og:image file is missing");
    else if (fs.statSync(f).size > 120 * 1024) fail(where, `og:image is ${Math.round(fs.statSync(f).size / 1024)} KB`);
  }

  // structure
  const h1 = d.headings.filter((h) => h.level === 1).length;
  if (h1 !== 1) fail(where, `${h1} h1 elements`);
  d.headings.reduce((prev, h) => {
    if (h.level > prev + 1) fail(where, `heading jumps from h${prev} to h${h.level} at "${h.text}"`);
    return h.level;
  }, 0);
  if (d.mains !== 1) fail(where, `${d.mains} main landmarks`);
  if (!d.landmarks.header || !d.landmarks.nav || !d.landmarks.footer) fail(where, "missing header/nav/footer landmark");
  for (const i of d.imgs) {
    if (i.alt === null) fail(where, `img ${i.src} has no alt attribute`);
    if (!i.w || !i.h) fail(where, `img ${i.src} has no width/height`);
  }
  if (d.emptyLinks) fail(where, `${d.emptyLinks} links without text`);

  // JSON-LD
  const types = [];
  for (const raw of d.jsonld) {
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      fail(where, `JSON-LD does not parse: ${e.message}`);
      continue;
    }
    types.push(j["@type"]);
    const walk = (o) => {
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string" && /^https?:\/\/(localhost|127\.)/.test(v)) fail(where, `JSON-LD has a local URL in ${k}`);
          if (["url", "item", "downloadUrl", "image", "screenshot", "releaseNotes", "softwareHelp"].includes(k) && typeof v === "string" && v.startsWith(BASE) && !fs.existsSync(path.join(SITE, v.slice(BASE.length) || "index.html")) && !fs.existsSync(path.join(SITE, v.slice(BASE.length), "index.html"))) fail(where, `JSON-LD ${k} ${v} does not exist`);
          walk(v);
        }
      }
    };
    walk(j);
    if (j["@type"] === "FAQPage") {
      const ld = j.mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text }));
      if (JSON.stringify(ld) !== JSON.stringify(d.faq)) fail(where, "FAQPage JSON-LD does not match the visible FAQ exactly");
      if (!d.faq.length) fail(where, "FAQPage without a visible FAQ");
    }
    if (j["@type"] === "SoftwareApplication") {
      if ("offers" in j) fail(where, "SoftwareApplication has offers, but pricing is undecided");
      for (const k of ["name", "operatingSystem", "applicationCategory", "downloadUrl", "softwareVersion"]) if (!j[k]) fail(where, `SoftwareApplication lacks ${k}`);
      const v = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
      if (j.softwareVersion !== v) fail(where, `softwareVersion ${j.softwareVersion} differs from package.json ${v}`);
    }
  }
  if (p === "") for (const t of ["WebSite", "SoftwareApplication", "FAQPage"]) if (!types.includes(t)) fail(where, `no ${t} JSON-LD`);
  if (p !== "" && p !== "404.html" && !types.includes("BreadcrumbList")) fail(where, "no BreadcrumbList JSON-LD");

  await checkRefs(where, d.refs);

  // layout at four widths, both themes
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const w of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(url);
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, wide: [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && r.width > 0 && !e.closest(".tablewrap, pre, .term, .win, .diff, .card, .cairn, .hero, .pagehero, [hidden]") && getComputedStyle(e).position !== "fixed"; }).slice(0, 3).map((e) => e.tagName + "." + e.className) }));
      if (o.sw > o.cw + 1) fail(where, `horizontal overflow at ${w}px ${theme}: scrollWidth ${o.sw} > ${o.cw} (${o.wide.join(", ")})`);
    }
  }

  // axe, both themes, desktop and phone
  for (const theme of ["light", "dark"]) {
    for (const w of [1280, 390]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(url);
      await page.addScriptTag({ content: AXE });
      const r = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      for (const v of r.violations) fail(where, `axe ${theme} ${w}px: ${v.id} (${v.impact}) on ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      note(`axe ${where} ${theme} ${w}px: ${r.violations.length} violations, ${r.passes.length} rules passed`);
    }
  }

  // mobile menu: closed by default, opens, axe-clean, closes on Escape, focus returns to the button
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(url);
  const btn = page.locator("#menu-btn");
  if (!(await btn.isVisible())) fail(where, "menu button is not visible at 390px");
  else {
    if ((await btn.getAttribute("aria-expanded")) !== "false") fail(where, "menu button should start with aria-expanded=false");
    if (await page.locator("#site-nav a").first().isVisible()) fail(where, "menu links should be hidden until opened");
    await btn.click();
    if ((await btn.getAttribute("aria-expanded")) !== "true" || !(await page.locator("#site-nav a").first().isVisible())) fail(where, "menu did not open");
    await page.addScriptTag({ content: AXE });
    const r = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
    for (const v of r.violations) fail(where, `axe (menu open): ${v.id} on ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
    await page.keyboard.press("Escape");
    if ((await btn.getAttribute("aria-expanded")) !== "false") fail(where, "Escape did not close the menu");
    if (!(await page.evaluate(() => document.activeElement?.id === "menu-btn"))) fail(where, "focus did not return to the menu button");
  }
  // keyboard: the skip link is the first tab stop
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await page.keyboard.press("Tab");
  if (!(await page.evaluate(() => document.activeElement?.classList.contains("skip")))) fail(where, "the skip link is not the first tab stop");
  await ctx.close();
}

// Unknown paths, at any depth: status 404, the custom page, and its CSS/JS/images come from THIS server (not the production URL).
for (const missing of ["/a", "/a/b/c", "/changelog/nope"]) {
  const where = `404 at ${missing}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const seen = [];
  page.on("request", (r) => seen.push(r.url()));
  const resp = await page.goto(ORIGIN + missing);
  if (resp.status() !== 404) fail(where, `status ${resp.status()}, expected 404`);
  if ((await page.locator("h1").textContent())?.trim() !== "This trail ends here.") fail(where, "the custom 404 page is not rendered");
  const outside = seen.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith("data:"));
  if (outside.length) fail(where, `requests left the local server: ${outside.join(", ")}`);
  if (!seen.includes(`${ORIGIN}/styles.css`)) fail(where, "styles.css was not loaded from the local server");
  if (!seen.includes(`${ORIGIN}/main.js`)) fail(where, "main.js was not loaded from the local server");
  for (const theme of ["light", "dark"]) {
    for (const w of [390, 1280]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(ORIGIN + missing);
      const s = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, menu: getComputedStyle(document.getElementById("menu-btn")).display }));
      const wantBg = theme === "light" ? "rgb(244, 245, 242)" : "rgb(16, 21, 23)";
      if (s.bg !== wantBg) fail(where, `stylesheet not applied (${theme} background is ${s.bg})`);
      if (s.sw > s.cw + 1) fail(where, `horizontal overflow at ${w}px ${theme}`);
      if (w === 390 && s.menu !== "flex") fail(where, "menu button is unstyled at 390px");
      await page.addScriptTag({ content: AXE });
      const r = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      for (const v of r.violations) fail(where, `axe ${theme} ${w}px: ${v.id} on ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
      note(`axe ${where} ${theme} ${w}px: ${r.violations.length} violations`);
    }
  }
  await ctx.close();
}

// screenshots for a human
fs.mkdirSync(SHOTS, { recursive: true });
for (const { p } of [...allPages, { p: "a/b/c" }]) {
  for (const theme of ["light", "dark"]) {
    for (const w of [1440, 820, 390]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: theme });
      const page = await ctx.newPage();
      await page.goto(`${ORIGIN}/${p}`);
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(SHOTS, `${(p || "index").replace(/[/.]+/g, "-").replace(/-$/, "")}-${theme}-${w}.png`), fullPage: true });
      await ctx.close();
    }
  }
}

await browser.close();
server.close();
note(`\n${allPages.length} pages, ${checkedLinks.size} distinct internal files resolved, ${external.size} external links (not fetched).`);
note(`Screenshots: ${path.relative(ROOT, SHOTS)}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map((x) => " - " + x).join("\n"));
  process.exit(1);
}
note("site checks passed");
