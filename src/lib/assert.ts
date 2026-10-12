import type { Assertion, Capture, ResponseData, TestResult } from "./types";

/** Tiny JSONPath: `$.a.b[0].c`, `a.b`, `items[2]`, `$['key']`. No filters/wildcards on purpose. */
export function getPath(data: unknown, path: string): unknown {
  const p = path.trim().replace(/^\$\.?/, "");
  if (!p) return data;
  const parts = [...p.matchAll(/\[(\d+)\]|\[['"]([^'"]+)['"]\]|([^.[\]]+)/g)].map((m) => (m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3])));
  let cur: any = data;
  for (const k of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k as any];
  }
  return cur;
}

export const parseJsonSafe = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "undefined");
const same = (actual: unknown, expected: string) =>
  String(actual) === expected || (typeof actual !== "string" && JSON.stringify(actual) === expected);

export function describeAssertion(a: Assertion): string {
  const target = a.kind === "json" ? `json ${a.path || "$"}` : a.kind === "header" ? `header ${a.path}` : a.kind;
  const ops: Record<string, string> = { eq: "equals", neq: "does not equal", contains: "contains", matches: "matches", exists: "exists", lt: "<", gt: ">" };
  return `${target} ${ops[a.op]}${a.op === "exists" ? "" : " " + a.value}`;
}

/** `sub` fills in {{variables}} in the expected value and the path, so an assertion can compare against a captured or environment value. */
export function runAssertions(list: Assertion[], res: ResponseData, sub: (s: string) => string = (s) => s): TestResult[] {
  const json = parseJsonSafe(res.body);
  return list
    .filter((a) => a.enabled)
    .map((raw) => {
      const a: Assertion = { ...raw, value: sub(raw.value), path: sub(raw.path) };
      const name = describeAssertion(a);
      let actual: unknown;
      switch (a.kind) {
        case "status": actual = res.status; break;
        case "time": actual = res.timeMs; break;
        case "body": actual = res.body; break;
        case "header": actual = res.headers.find(([k]) => k.toLowerCase() === a.path.trim().toLowerCase())?.[1]; break;
        case "json": actual = json === undefined ? undefined : getPath(json, a.path); break;
      }
      let ok = false;
      try {
        switch (a.op) {
          case "exists": ok = actual !== undefined && actual !== null; break;
          case "eq": ok = same(actual, a.value); break;
          case "neq": ok = !same(actual, a.value); break;
          case "contains": ok = typeof actual === "string" ? actual.includes(a.value) : Array.isArray(actual) ? actual.some((x) => same(x, a.value)) : false; break;
          case "matches": ok = new RegExp(a.value).test(String(actual ?? "")); break;
          case "lt": ok = Number(actual) < Number(a.value); break;
          case "gt": ok = Number(actual) > Number(a.value); break;
        }
      } catch (e) {
        return { name, passed: false, error: `Invalid assertion: ${e}` };
      }
      return ok ? { name, passed: true } : { name, passed: false, error: `got ${show(actual)}` };
    });
}

export function runCaptures(list: Capture[], res: ResponseData): { values: Record<string, string>; missed: string[] } {
  const json = parseJsonSafe(res.body);
  const values: Record<string, string> = {};
  const missed: string[] = [];
  for (const c of list) {
    if (!c.variable) continue;
    const v =
      c.from === "header"
        ? res.headers.find(([k]) => k.toLowerCase() === c.path.trim().toLowerCase())?.[1]
        : json === undefined ? undefined : getPath(json, c.path);
    if (v === undefined || v === null) missed.push(c.variable);
    else values[c.variable] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return { values, missed };
}
