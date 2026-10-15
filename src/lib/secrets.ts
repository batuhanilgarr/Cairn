/**
 * Secret scanner: finds credentials that would be committed to Git because they sit in a collection file
 * (requests, folder defaults, environments) instead of in a secret variable. Pure functions: the app, the CLI
 * and the tests all use the same code. A finding never contains the whole secret, only a masked preview,
 * so scan output is safe to paste into CI logs.
 */

export type Severity = "high" | "medium" | "low";

export type Finding = {
  file: string;
  /** 1-based line number. */
  line: number;
  rule: string;
  /** Human name, e.g. "GitHub token" or "Password in auth.password". */
  kind: string;
  severity: Severity;
  /** Where in the file it sits, e.g. the key name. */
  where: string;
  /** Masked: the start of the value and its length, never the whole thing. */
  preview: string;
  /** Column range of the secret inside its line (0-based, end exclusive), used by the fix. */
  start: number;
  end: number;
  /** A reference such as {{apiKey}} can replace the value (false for structural findings). */
  fixable: boolean;
  /** Suggested variable name for the fix. */
  suggest: string;
};

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
export const atLeast = (f: Finding, min: Severity) => RANK[f.severity] >= RANK[min];

/* ------------------------------ known formats ----------------------------- */

type Rule = { id: string; kind: string; severity: Severity; re: RegExp; group?: number };

// Order matters: the first rule that claims a stretch of text wins, so specific formats come before generic ones.
const RULES: Rule[] = [
  { id: "private-key", kind: "Private key", severity: "high", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { id: "aws-access-key", kind: "AWS access key ID", severity: "high", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", kind: "GitHub token", severity: "high", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { id: "slack-token", kind: "Slack token", severity: "high", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-key", kind: "Stripe live key", severity: "high", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g },
  { id: "google-api-key", kind: "Google API key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "anthropic-key", kind: "Anthropic API key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", kind: "OpenAI-style API key", severity: "high", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "npm-token", kind: "npm token", severity: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sendgrid-key", kind: "SendGrid API key", severity: "high", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: "jwt", kind: "JSON Web Token", severity: "high", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: "url-credentials", kind: "Password inside a URL", severity: "high", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@{}'"]+:([^\s/@{}'"]+)@/gi, group: 1 },
  { id: "basic-literal", kind: "Basic auth credentials", severity: "high", re: /\bBasic\s+([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g, group: 1 },
  { id: "bearer-literal", kind: "Bearer token", severity: "medium", re: /\bBearer\s+((?![{<$])[A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
];

/* ---------------------------- sensitive key names ---------------------------- */

const SENSITIVE = /(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|credential|client[_-]?secret)/i;
/** Names that look sensitive but hold a description, a location or a setting, not a secret. */
const NOT_A_VALUE = /(url|uri|endpoint|path|name|header|prefix|scheme|type|mode|location|field|place|method|source|expires|expiry|ttl|lifetime|length|count|enabled|required|file|policy|style|format)$/i;
const PLACEHOLDER = /^(x+|\*+|\.{3}|<.*>|\$\{.*\}|\$[A-Za-z_]\w*|your[-_ ].*|change[-_ ]?me|example.*|sample.*|dummy.*|placeholder.*|redacted|todo|tbd|secret|password|passwd|token|null|none|undefined|true|false|test|testing|abc|abc123|123456|string|value)$/i;

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2").trim();
const looksLikeValue = (v: string, min: number) => {
  if (v.length < min || PLACEHOLDER.test(v) || v.includes("{{") || v === "|" || v === ">" || v === "|-" || v === ">-") return false;
  if (/^https?:\/\/[^\s:@]*$/i.test(v)) return false; // a plain URL, no credentials
  return true;
};

const mask = (v: string, known: boolean) => `${v.slice(0, known ? 4 : 2)}…(${v.length} chars)`;

/** A variable name to suggest for a secret that sits under this key. */
export function suggestVarName(key: string, file: string): string {
  const raw = key.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
  if (raw && !/^\d/.test(raw)) return raw;
  const stem = (file.split("/").pop() ?? "secret").replace(/\..*$/, "").replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
  return `${stem || "secret"}Secret`;
}

/* --------------------------------- scanning -------------------------------- */

const IGNORE = /cairn[-: ]?ignore/i;
const PAIR = /^(\s*-?\s*)([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/;
// "password": "abc" or password=abc inside bodies and URLs
const INLINE = /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']([^"'\\\n]{4,})["']/g;
const QUERY = /[?&]([A-Za-z_][\w.-]*)=([^&\s#"'{}]+)/g;

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let itemKey: string | null = null; // the `key:` / `name:` of the current list item, for its `value:`
  let inBlock = false;
  let blockIndent = 0;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const indent = raw.length - raw.trimStart().length;
    if (inBlock && raw.trim() && indent < blockIndent) inBlock = false;
    if (IGNORE.test(raw)) return;
    const claimed: [number, number][] = [];
    const free = (s: number, e: number) => !claimed.some(([a, b]) => s < b && e > a);
    const add = (f: Omit<Finding, "file" | "line">) => {
      if (!free(f.start, f.end)) return;
      claimed.push([f.start, f.end]);
      out.push({ file, line, ...f });
    };

    // 1. known formats anywhere in the line
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (const m of raw.matchAll(r.re)) {
        const g = r.group ?? 0;
        const val = m[g];
        if (!val || val.includes("{{")) continue;
        const start = (m.index ?? 0) + (g ? m[0].indexOf(val) : 0);
        const key = PAIR.exec(raw)?.[2] ?? r.id;
        add({ rule: r.id, kind: r.kind, severity: r.severity, where: key, preview: mask(val, r.id !== "private-key"), start, end: start + val.length, fixable: r.id !== "private-key", suggest: suggestVarName(key === r.id ? r.kind : key, file) });
      }
    }

    // 2. a sensitive key with a literal value (YAML pair)
    const pair = PAIR.exec(raw);
    if (pair) {
      const [, lead, key, rest] = pair;
      if (/^\s*-/.test(lead)) itemKey = null; // a new list item
      const v = unquote(rest);
      if (key === "key" || key === "name" || key === "header") itemKey = v;
      if (!inBlock && rest && /^[|>][+-]?$/.test(rest)) {
        inBlock = true;
        blockIndent = indent + 1;
      }
      const target = key === "value" ? itemKey : key;
      if (target && SENSITIVE.test(target) && !NOT_A_VALUE.test(target) && looksLikeValue(v, /pass|pwd/i.test(target) ? 4 : 6)) {
        const start = raw.indexOf(rest, lead.length + key.length);
        const body = rest.length >= 2 && /^["']/.test(rest) ? 1 : 0;
        add({ rule: "sensitive-key", kind: `Literal value for ${target}`, severity: "medium", where: key === "value" ? `${target} (value)` : key, preview: mask(v, false), start: start + body, end: start + body + v.length, fixable: true, suggest: suggestVarName(target, file) });
      }
    }

    // 3. "password": "abc" / password=abc inside bodies, and ?api_key=... in URLs
    if (inBlock || !pair) {
      for (const m of raw.matchAll(INLINE)) {
        const [, key, val] = m;
        if (SENSITIVE.test(key) && !NOT_A_VALUE.test(key) && looksLikeValue(val, 4)) {
          const start = (m.index ?? 0) + m[0].lastIndexOf(val);
          add({ rule: "sensitive-key", kind: `Literal value for ${key}`, severity: "medium", where: key, preview: mask(val, false), start, end: start + val.length, fixable: true, suggest: suggestVarName(key, file) });
        }
      }
    }
    for (const m of raw.matchAll(QUERY)) {
      const [, key, val] = m;
      if (SENSITIVE.test(key) && !NOT_A_VALUE.test(key) && looksLikeValue(val, 6)) {
        const start = (m.index ?? 0) + m[0].indexOf("=") + 1;
        add({ rule: "query-secret", kind: `Secret in the URL (${key})`, severity: "medium", where: key, preview: mask(val, false), start, end: start + val.length, fixable: true, suggest: suggestVarName(key, file) });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The secrets directory must be git-ignored, or "secret" variables end up in the repository after all. */
export function checkGitignore(root: string, hasGit: boolean, gitignore: string | null, hasSecretsDir: boolean): Finding | null {
  if (!hasGit) return null;
  const ignored = (gitignore ?? "").split(/\r?\n/).some((l) => /^\/?\.(cairn|reqnest)\/?\*?$/.test(l.trim()));
  if (ignored || !hasSecretsDir) return null;
  return { file: `${root}/.gitignore`, line: 0, rule: "gitignore", kind: "The secrets folder is not git-ignored", severity: "high", where: ".cairn/", preview: "add .cairn/ to .gitignore", start: 0, end: 0, fixable: false, suggest: "" };
}

/** Replace the secret in `text` with a variable reference. Returns null when the line no longer matches. */
export function applyFix(text: string, f: Finding, varName: string): string | null {
  const lines = text.split("\n");
  const raw = lines[f.line - 1];
  if (raw === undefined || !f.fixable || f.end <= f.start || f.end > raw.length) return null;
  const cr = raw.endsWith("\r");
  lines[f.line - 1] = raw.slice(0, f.start) + `{{${varName}}}` + raw.slice(f.end);
  void cr;
  return lines.join("\n");
}

/** Group a flat list by file (stable order). */
export function byFile(findings: Finding[]): [string, Finding[]][] {
  const m = new Map<string, Finding[]>();
  for (const f of findings) m.set(f.file, [...(m.get(f.file) ?? []), f]);
  return [...m.entries()];
}
