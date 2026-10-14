import type { TestResult } from "../../src/lib/types";

export type ReqResult = {
  file: string;
  rel: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  error?: string;
  skipped?: string;
  iteration: number;
  tests: TestResult[];
  logs: string[];
};

export type Report = {
  collection: string;
  environment?: string;
  startedAt: string;
  durationMs: number;
  iterations: number;
  results: ReqResult[];
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** JUnit XML, the format every CI understands. One test case per assertion; a request with no tests is one case that passes unless the request itself failed. */
export function junitXml(rep: Report): string {
  const real = rep.results.filter((r) => !r.skipped);
  let total = 0, failures = 0;
  const cases: string[] = [];
  for (const r of real) {
    const cls = esc(r.rel.replace(/\.req\.ya?ml$/, "") + (rep.iterations > 1 ? ` (iteration ${r.iteration})` : ""));
    const time = ((r.ms ?? 0) / 1000).toFixed(3);
    if (r.error) {
      total++, failures++;
      cases.push(`    <testcase classname="${cls}" name="${esc(r.name)}" time="${time}"><failure message="${esc(r.error.split("\n")[0])}">${esc(r.error)}</failure></testcase>`);
    }
    if (!r.tests.length && !r.error) {
      total++;
      cases.push(`    <testcase classname="${cls}" name="${esc(r.name)}" time="${time}"/>`);
    }
    for (const t of r.tests) {
      total++;
      if (t.passed) cases.push(`    <testcase classname="${cls}" name="${esc(r.name + " › " + t.name)}" time="${time}"/>`);
      else {
        failures++;
        cases.push(`    <testcase classname="${cls}" name="${esc(r.name + " › " + t.name)}" time="${time}"><failure message="${esc(t.error ?? "assertion failed")}">${esc(`${r.method} ${r.url} → ${r.status ?? "no response"}\n${t.error ?? ""}`)}</failure></testcase>`);
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(rep.collection)}" tests="${total}" failures="${failures}" time="${(rep.durationMs / 1000).toFixed(3)}">\n  <testsuite name="${esc(rep.collection)}${rep.environment ? ` (${esc(rep.environment)})` : ""}" tests="${total}" failures="${failures}" timestamp="${esc(rep.startedAt)}" time="${(rep.durationMs / 1000).toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}

export function htmlReport(rep: Report): string {
  const real = rep.results.filter((r) => !r.skipped);
  const bad = (r: ReqResult) => !!r.error || r.tests.some((t) => !t.passed);
  const rows = rep.results
    .map((r) => {
      const ok = !bad(r);
      const tests = r.tests.map((t) => `<li class="${t.passed ? "p" : "f"}">${t.passed ? "✓" : "✗"} ${esc(t.name)}${t.error ? ` <em>${esc(t.error)}</em>` : ""}</li>`).join("");
      return `<tr class="${r.skipped ? "s" : ok ? "p" : "f"}"><td>${r.skipped ? "–" : ok ? "✓" : "✗"}</td><td><b>${esc(r.name)}</b><br><small>${esc(r.rel)}</small></td><td>${esc(r.method)}</td><td>${r.status ?? ""}</td><td>${r.ms ?? ""}</td><td>${r.error ? `<span class="e">${esc(r.error)}</span>` : r.skipped ? esc(r.skipped) : ""}<ul>${tests}</ul></td></tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Cairn report: ${esc(rep.collection)}</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:32px auto;max-width:1000px;color:#1d1d1f}h1{font-size:20px}table{width:100%;border-collapse:collapse}td,th{padding:8px 10px;border-bottom:1px solid #e3e3e8;vertical-align:top;text-align:left}th{font-size:11px;text-transform:uppercase;color:#7a7a85}.p td:first-child{color:#17a34a}.f td:first-child{color:#dc2626}.f{background:#fef2f2}ul{margin:4px 0 0;padding-left:18px;list-style:none}li.f{color:#dc2626}li.p{color:#17a34a}em{color:#7a7a85}.e{color:#dc2626}small{color:#7a7a85}.sum{margin:8px 0 20px;color:#555}</style>
<h1>◆ ${esc(rep.collection)}${rep.environment ? ` · ${esc(rep.environment)}` : ""}</h1>
<p class="sum">${real.length} requests, ${real.filter(bad).length} failed · ${rep.durationMs} ms · ${esc(rep.startedAt)}</p>
<table><thead><tr><th></th><th>Request</th><th>Method</th><th>Status</th><th>ms</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
}
