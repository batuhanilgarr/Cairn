/** Parse the text of a `.env` file into key/value pairs (no variable expansion: values are kept as written). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.\-]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let rest = m[2];
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      // quoted: runs to the matching quote, possibly over several lines
      let body = rest.slice(1);
      let end = closing(body, q);
      while (end < 0 && i + 1 < lines.length) {
        body += "\n" + lines[++i];
        end = closing(body, q);
      }
      const raw = end < 0 ? body : body.slice(0, end);
      out[key] = q === '"' ? raw.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1") : raw;
    } else {
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      out[key] = rest.trim();
    }
  }
  return out;
}

/** Index of the first unescaped closing quote, or -1. */
function closing(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && q === '"') i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

/** Environment name for a dotenv file: `.env.staging` -> "staging", `.env` -> "dotenv", `prod.env` -> "prod". */
export function dotenvName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const m = /^\.env\.(.+)$/.exec(base) ?? /^(.+)\.env$/.exec(base);
  return m ? m[1] : base === ".env" ? "dotenv" : base.replace(/^\./, "");
}
