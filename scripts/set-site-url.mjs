#!/usr/bin/env node
/**
 * Moves the website to a new address (for example a custom domain).
 *
 *   node scripts/set-site-url.mjs https://cairn.example.com/
 *
 * The current address is recorded in website/site.json. This script replaces it in every text file under
 * website/ (canonical links, Open Graph and JSON-LD URLs, sitemap, robots.txt, the 404 <base>, the JSON Schema
 * $id values) and in docs/file-format.md, then records the new one. Internal links are relative and need no change.
 * Run `npm run test:site` afterwards. If the new site is served from a domain root, nothing else has to change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteJson = path.join(root, "website", "site.json");
const arg = process.argv[2];
if (!arg || !/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(arg)) {
  console.error("Usage: node scripts/set-site-url.mjs https://your.domain/[path/]");
  process.exit(2);
}
const next = arg.endsWith("/") ? arg : arg + "/";
const old = JSON.parse(fs.readFileSync(siteJson, "utf8")).url;
if (old === next) {
  console.log("Already " + next);
  process.exit(0);
}

const TEXT = /\.(html|xml|txt|json|webmanifest|md|svg|js|css)$/;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (TEXT.test(e.name)) files.push(p);
  }
})(path.join(root, "website"));
files.push(path.join(root, "docs", "file-format.md"));

let changed = 0;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  if (!text.includes(old)) continue;
  fs.writeFileSync(f, text.split(old).join(next));
  changed++;
  console.log("updated " + path.relative(root, f));
}
const rec = JSON.parse(fs.readFileSync(siteJson, "utf8"));
rec.url = next;
fs.writeFileSync(siteJson, JSON.stringify(rec, null, 2) + "\n");
console.log(`${old} -> ${next} in ${changed} files. Now run: npm run test:site`);
