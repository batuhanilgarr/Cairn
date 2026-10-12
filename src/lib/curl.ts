import type { RequestTab } from "./types";
import { emptyKV, newTab, tryPrettyJson } from "./util";

export const looksLikeCurl = (s: string) => /^\s*curl(\s|$)/i.test(s);

/** Shell-style tokenizer: quotes, backslash escapes, $'...' strings and line continuations. */
export function tokenize(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j === -1 ? s.length : j;
      cur += s.slice(i + 1, end);
      i = end;
      has = true;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i];
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else cur += s[i];
      }
      has = true;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
        else cur += s[i];
      }
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
  "--data-urlencode", "-u", "--user", "-A", "--user-agent", "-b", "--cookie", "-e", "--referer",
  "-m", "--max-time", "--url", "-F", "--form", "-o", "--output", "-x", "--proxy", "--connect-timeout",
  "--retry", "-w", "--write-out", "--cacert", "--cert", "--key", "-T", "--upload-file", "--http1.1",
]);

export type CurlResult = { tab: RequestTab; notes: string[] };

export function parseCurl(command: string): CurlResult {
  const toks = tokenize(command.trim());
  const notes: string[] = [];
  const tab = newTab();
  let method: string | null = null;
  let url = "";
  const data: string[] = [];
  const headers: { key: string; value: string }[] = [];
  let getMode = false;
  let head = false;

  for (let i = 1; i < toks.length; i++) {
    let t = toks[i];
    let val: string | undefined;
    // --flag=value and -XPOST / -HValue short forms
    if (t.startsWith("--") && t.includes("=")) {
      val = t.slice(t.indexOf("=") + 1);
      t = t.slice(0, t.indexOf("="));
    } else if (/^-[XHduAbemFo].+/.test(t) && !t.startsWith("--")) {
      val = t.slice(2);
      t = t.slice(0, 2);
    }
    const next = () => (val !== undefined ? val : toks[++i] ?? "");

    if (!t.startsWith("-")) {
      if (!url) url = t;
      continue;
    }
    switch (t) {
      case "-X": case "--request": method = next().toUpperCase(); break;
      case "-H": case "--header": {
        const h = next();
        const idx = h.indexOf(":");
        if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": data.push(next()); break;
      case "--data-urlencode": {
        const v = next();
        const eq = v.indexOf("=");
        data.push(eq === -1 ? encodeURIComponent(v) : `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`);
        break;
      }
      case "-u": case "--user": {
        const v = next();
        const c = v.indexOf(":");
        tab.authMode = "basic";
        tab.authUser = c === -1 ? v : v.slice(0, c);
        tab.authPass = c === -1 ? "" : v.slice(c + 1);
        break;
      }
      case "-A": case "--user-agent": headers.push({ key: "User-Agent", value: next() }); break;
      case "-e": case "--referer": headers.push({ key: "Referer", value: next() }); break;
      case "-b": case "--cookie": headers.push({ key: "Cookie", value: next() }); break;
      case "-m": case "--max-time": tab.timeoutMs = Math.round((parseFloat(next()) || 30) * 1000); break;
      case "--url": url = next(); break;
      case "-k": case "--insecure": tab.insecure = true; break;
      case "-L": case "--location": tab.followRedirects = true; break;
      case "-G": case "--get": getMode = true; break;
      case "-I": case "--head": head = true; break;
      case "-F": case "--form": next(); notes.push("multipart form (-F) isn't supported yet and was skipped"); break;
      default:
        if (VALUE_FLAGS.has(t)) next(); // known flag we don't use: swallow its value
    }
  }

  if (getMode && data.length) {
    url += (url.includes("?") ? "&" : "?") + data.join("&");
    data.length = 0;
  }
  tab.url = url;
  tab.method = head ? "HEAD" : method ?? (data.length ? "POST" : "GET");

  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (data.length) {
    const body = data.join("&");
    const isJson = ct.includes("json") || (!ct && tryPrettyJson(body) !== null);
    tab.bodyMode = isJson ? "json" : ct.includes("x-www-form-urlencoded") || !ct ? "form" : "text";
    tab.body = isJson ? (tryPrettyJson(body) ?? body) : body;
    // Content-Type is filled in automatically when the command didn't set one.
    if (!ct) headers.push({ key: "Content-Type", value: isJson ? "application/json" : "application/x-www-form-urlencoded" });
  }
  tab.headers = [...headers.map((h) => ({ ...emptyKV(), ...h })), emptyKV()];
  tab.name = "New request";
  return { tab, notes };
}
