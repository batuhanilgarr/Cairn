import fs from "node:fs";
import path from "node:path";
import { atLeast, byFile, checkGitignore, scanText, type Finding, type Severity } from "../../src/lib/secrets";

const SKIP = new Set([".git", "node_modules", ".cairn", ".reqnest", "dist", "target"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ya?ml$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** Scan every YAML file under a collection (or any folder) for credentials that would be committed. */
export function scanDirectory(root: string): Finding[] {
  const abs = path.resolve(root);
  const findings: Finding[] = [];
  for (const file of walk(abs)) {
    const rel = path.relative(abs, file).split(path.sep).join("/");
    findings.push(...scanText(rel, fs.readFileSync(file, "utf8")));
  }
  let top = abs;
  let hasGit = false;
  for (let d = abs; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) {
      hasGit = true;
      top = d;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  const gi = hasGit && fs.existsSync(path.join(top, ".gitignore")) ? fs.readFileSync(path.join(top, ".gitignore"), "utf8") : null;
  const hasSecrets = fs.existsSync(path.join(abs, ".cairn")) || fs.existsSync(path.join(abs, ".reqnest"));
  const g = checkGitignore(".", hasGit, [gi ?? "", fs.existsSync(path.join(abs, ".gitignore")) ? fs.readFileSync(path.join(abs, ".gitignore"), "utf8") : ""].join("\n"), hasSecrets);
  if (g) findings.push({ ...g, file: ".gitignore" });
  return findings;
}

export function formatFindings(findings: Finding[], color: { red: (s: string) => string; yellow: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string; green: (s: string) => string }): string {
  if (!findings.length) return color.green("No secrets found in collection files.");
  const lines = [color.bold(`Secret scan: ${findings.length} finding${findings.length > 1 ? "s" : ""} in ${byFile(findings).length} file${byFile(findings).length > 1 ? "s" : ""}`), ""];
  for (const [file, list] of byFile(findings)) {
    lines.push(file);
    for (const f of list) {
      const sev = f.severity === "high" ? color.red("high  ") : f.severity === "medium" ? color.yellow("medium") : "low   ";
      lines.push(`  ${String(f.line || "").padStart(4)}  ${sev}  ${f.kind}  ${color.dim(f.preview)}`);
    }
    lines.push("");
  }
  lines.push(color.dim('Move these values into secret variables (Cairn: Scan for secrets > Fix). Silence a line with "# cairn-ignore".'));
  return lines.join("\n");
}

export const SEVERITIES: Severity[] = ["high", "medium", "low"];
export { atLeast };
