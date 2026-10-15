#!/usr/bin/env node
/**
 * Serves website/ the way GitHub Pages does: directories get their index.html (with a redirect to the trailing slash),
 * and any unknown path answers 404 with the body of 404.html, at any depth (/a, /a/b/c).
 *
 *   node scripts/serve-site.mjs [port]        (default 4350, or SITE_PORT)
 *   npm run site:serve
 *
 * Also used by tests/site/check.mjs, so what you preview is what the checks run against.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "website");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function startSiteServer(port, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = path.join(SITE, p);
    if (!f.startsWith(SITE)) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
      if (!p.endsWith("/")) return res.writeHead(301, { Location: p + "/" }).end();
      f = path.join(f, "index.html");
    }
    if (!fs.existsSync(f)) {
      res.writeHead(404, { "Content-Type": TYPES[".html"] });
      return res.end(fs.readFileSync(path.join(SITE, "404.html")));
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.SITE_PORT || 4350);
  await startSiteServer(port);
  console.log(`Serving website/ like GitHub Pages on http://127.0.0.1:${port}/  (try /a and /404.html)`);
}
