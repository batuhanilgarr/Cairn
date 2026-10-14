/**
 * Response filter: JSONPath (starts with `$`) or a practical subset of jq (everything else).
 * Pure functions, no dependencies, shared by the app and the CLI.
 *
 * jq subset: `.`, `..`, `.a.b`, `.["k"]`, `.[0]`, `.[-1]`, `.[2:5]`, `.[]`, `?`, pipes, commas, `//`,
 * `and` `or` `not`, comparisons, `+ - * / %`, `[ ... ]`, `{ a, b: ., "c": ... }`, `if/then/elif/else/end`,
 * and the functions length keys values map select first last sort sort_by group_by unique reverse add min max
 * min_by max_by has contains startswith endswith test ascii_downcase ascii_upcase tostring tonumber tojson fromjson
 * type not empty flatten any all join split range limit to_entries from_entries abs floor ceil round.
 * JSONPath: `$.a.b`, `$..k`, `$.a[0]`, `$.a[-1]`, `$.a[1:3]`, `$.a[*]`, `$['k']`, `$.a['x','y']`, `$.a[0,2]`,
 * `$.a[?(@.price < 10 && @.in_stock)]`.
 */

export type FilterResult = { ok: true; values: unknown[]; syntax: "jsonpath" | "jq" } | { ok: false; error: string };

class FilterError extends Error {}
function fail(m: string): never {
  throw new FilterError(m);
}

/* -------------------------------- tokens -------------------------------- */

type Tok = { t: string; v?: string | number };

const SYMBOLS = ["..", "//", "==", "!=", "<=", ">=", "|", ",", "(", ")", "[", "]", "{", "}", ":", ";", "?", "<", ">", "+", "-", "*", "/", "%", "."];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) fail("Unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? "") && !/[\w\]")]/.test(src[i - 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === "." && src[i + 1] !== ".") {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m) {
        out.push({ t: "field", v: m[1] });
        i += m[0].length;
        continue;
      }
      if (src[i + 1] === '"') {
        const j = src.indexOf('"', i + 2);
        if (j < 0) fail("Unterminated string");
        out.push({ t: "field", v: src.slice(i + 2, j) });
        i = j + 1;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (!sym) return fail(`Unexpected "${c}"`);
    out.push({ t: sym });
    i += sym.length;
  }
  return out;
}

/* --------------------------------- parser -------------------------------- */

type Node =
  | { k: "id" }
  | { k: "rec" }
  | { k: "lit"; v: unknown }
  | { k: "field"; of: Node; name: string; opt: boolean }
  | { k: "index"; of: Node; at: Node; opt: boolean }
  | { k: "slice"; of: Node; from: Node | null; to: Node | null; opt: boolean }
  | { k: "iter"; of: Node; opt: boolean }
  | { k: "try"; of: Node }
  | { k: "pipe"; a: Node; b: Node }
  | { k: "comma"; a: Node; b: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "arr"; of: Node | null }
  | { k: "obj"; entries: [Node, Node][] }
  | { k: "call"; name: string; args: Node[] }
  | { k: "if"; cond: Node; then: Node; else: Node | null };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  is(t: string, v?: string): boolean {
    const p = this.peek();
    return !!p && p.t === t && (v === undefined || p.v === v);
  }
  eat(t: string): boolean {
    if (this.is(t)) {
      this.i++;
      return true;
    }
    return false;
  }
  expect(t: string) {
    if (!this.eat(t)) fail(`Expected "${t}"${this.peek() ? ` but found "${this.peek()!.t === "id" || this.peek()!.t === "field" ? this.peek()!.v : this.peek()!.t}"` : " at the end"}`);
  }
  kw(w: string): boolean {
    if (this.is("id", w)) {
      this.i++;
      return true;
    }
    return false;
  }
  done() {
    if (this.i < this.toks.length) fail(`Unexpected "${this.peek()!.v ?? this.peek()!.t}"`);
  }

  pipe(): Node {
    let a = this.comma();
    while (this.eat("|")) a = { k: "pipe", a, b: this.comma() };
    return a;
  }
  comma(): Node {
    let a = this.alt();
    while (this.eat(",")) a = { k: "comma", a, b: this.alt() };
    return a;
  }
  alt(): Node {
    let a = this.or();
    while (this.eat("//")) a = { k: "bin", op: "//", a, b: this.or() };
    return a;
  }
  or(): Node {
    let a = this.and();
    while (this.kw("or")) a = { k: "bin", op: "or", a, b: this.and() };
    return a;
  }
  and(): Node {
    let a = this.cmp();
    while (this.kw("and")) a = { k: "bin", op: "and", a, b: this.cmp() };
    return a;
  }
  cmp(): Node {
    const a = this.add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"]) if (this.eat(op)) return { k: "bin", op, a, b: this.add() };
    return a;
  }
  add(): Node {
    let a = this.mul();
    for (;;) {
      if (this.eat("+")) a = { k: "bin", op: "+", a, b: this.mul() };
      else if (this.eat("-")) a = { k: "bin", op: "-", a, b: this.mul() };
      else return a;
    }
  }
  mul(): Node {
    let a = this.unary();
    for (;;) {
      const op = ["*", "/", "%"].find((o) => this.eat(o));
      if (!op) return a;
      a = { k: "bin", op, a, b: this.unary() };
    }
  }
  unary(): Node {
    if (this.eat("-")) return { k: "neg", a: this.unary() };
    return this.postfix();
  }
  postfix(): Node {
    let n = this.term();
    for (;;) {
      const p = this.peek();
      if (!p) return n;
      if (p.t === "field") {
        this.i++;
        n = { k: "field", of: n, name: String(p.v), opt: false };
      } else if (p.t === "." && this.toks[this.i + 1]?.t === "[") {
        this.i++;
      } else if (p.t === "[") {
        this.i++;
        n = this.bracket(n);
      } else if (p.t === "?") {
        this.i++;
        n = { k: "try", of: n };
      } else return n;
    }
  }
  bracket(of: Node): Node {
    if (this.eat("]")) return { k: "iter", of, opt: false };
    if (this.eat(":")) {
      const to = this.pipe();
      this.expect("]");
      return { k: "slice", of, from: null, to, opt: false };
    }
    const at = this.pipe();
    if (this.eat(":")) {
      const to = this.is("]") ? null : this.pipe();
      this.expect("]");
      return { k: "slice", of, from: at, to, opt: false };
    }
    this.expect("]");
    return { k: "index", of, at, opt: false };
  }
  term(): Node {
    const p = this.peek();
    if (!p) return fail("Expected an expression");
    this.i++;
    switch (p.t) {
      case "field":
        return { k: "field", of: { k: "id" }, name: String(p.v), opt: false };
      case "..":
        return { k: "rec" };
      case ".":
        return { k: "id" };
      case "num":
      case "str":
        return { k: "lit", v: p.v };
      case "(": {
        const e = this.pipe();
        this.expect(")");
        return e;
      }
      case "[": {
        if (this.eat("]")) return { k: "arr", of: null };
        const e = this.pipe();
        this.expect("]");
        return { k: "arr", of: e };
      }
      case "{":
        return this.object();
      case "id": {
        const name = String(p.v);
        if (name === "true") return { k: "lit", v: true };
        if (name === "false") return { k: "lit", v: false };
        if (name === "null") return { k: "lit", v: null };
        if (name === "if") return this.ifExpr();
        const args: Node[] = [];
        if (this.eat("(")) {
          args.push(this.pipe());
          while (this.eat(";")) args.push(this.pipe());
          this.expect(")");
        }
        return { k: "call", name, args };
      }
      default:
        return fail(`Unexpected "${p.t}"`);
    }
  }
  ifExpr(): Node {
    const cond = this.pipe();
    if (!this.kw("then")) fail('Expected "then"');
    const then = this.pipe();
    let els: Node | null = null;
    if (this.kw("elif")) els = this.ifExpr();
    else {
      if (this.kw("else")) els = this.pipe();
      if (!this.kw("end")) fail('Expected "end"');
    }
    return { k: "if", cond, then, else: els };
  }
  object(): Node {
    const entries: [Node, Node][] = [];
    if (this.eat("}")) return { k: "obj", entries };
    do {
      const p = this.peek();
      let key: Node;
      let short: string | null = null;
      if (p?.t === "id" || p?.t === "str") {
        this.i++;
        key = { k: "lit", v: p.v };
        short = String(p.v);
      } else if (p?.t === "field") {
        this.i++;
        key = { k: "lit", v: p.v };
        short = String(p.v);
      } else if (this.eat("(")) {
        key = this.pipe();
        this.expect(")");
      } else return fail("Expected an object key");
      let value: Node;
      if (this.eat(":")) value = this.alt();
      else if (short !== null) value = { k: "field", of: { k: "id" }, name: short, opt: false };
      else return fail('Expected ":"');
      entries.push([key, value]);
    } while (this.eat(","));
    this.expect("}");
    return { k: "obj", entries };
  }
}

/* ------------------------------- evaluation ------------------------------ */

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const truthy = (v: unknown) => v !== null && v !== false && v !== undefined;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const brief = (v: unknown) => {
  const s = JSON.stringify(v) ?? "null";
  return s.length > 24 ? s.slice(0, 21) + "..." : s;
};

function order(a: unknown, b: unknown): number {
  const rank = (v: unknown) => ({ null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 })[typeOf(v) as "null"] ?? 6;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a === null) return 0;
  if (typeof a === "boolean") return Number(a) - Number(b as boolean);
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "string") return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    for (let i = 0; i < Math.min(a.length, bb.length); i++) {
      const c = order(a[i], bb[i]);
      if (c) return c;
    }
    return a.length - bb.length;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  const c = order(ka, kb);
  if (c) return c;
  for (const k of ka) {
    const d = order((a as any)[k], (b as any)[k]);
    if (d) return d;
  }
  return 0;
}
const same = (a: unknown, b: unknown) => order(a, b) === 0;

function* descend(v: unknown): Generator<unknown> {
  yield v;
  if (Array.isArray(v)) for (const x of v) yield* descend(x);
  else if (isObj(v)) for (const x of Object.values(v)) yield* descend(x);
}

function index(v: unknown, k: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (isObj(v) && typeof k === "string") return k in v ? v[k] : null;
  if (Array.isArray(v) && typeof k === "number") return v[k < 0 ? v.length + k : k] ?? null;
  return fail(`Cannot index ${typeOf(v)} with ${typeof k === "string" ? `"${k}"` : typeOf(k)}`);
}

function arith(op: string, a: unknown, b: unknown): unknown {
  if (op === "+") {
    if (a === null) return b;
    if (b === null) return a;
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (isObj(a) && isObj(b)) return { ...a, ...b };
    return fail(`${typeOf(a)} (${brief(a)}) and ${typeOf(b)} (${brief(b)}) cannot be added`);
  }
  if (typeof a === "number" && typeof b === "number") {
    if (op === "-") return a - b;
    if (op === "*") return a * b;
    if (b === 0) return fail(`${brief(a)} and ${brief(b)} cannot be divided because the divisor is zero`);
    return op === "/" ? a / b : a % b;
  }
  if (op === "-" && Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => same(x, y)));
  if (op === "*" && typeof a === "string" && typeof b === "number") return b > 0 ? a.repeat(b) : null;
  if (op === "/" && typeof a === "string" && typeof b === "string") return a.split(b);
  return fail(`${typeOf(a)} (${brief(a)}) and ${typeOf(b)} (${brief(b)}) cannot be ${op === "-" ? "subtracted" : op === "*" ? "multiplied" : "divided"}`);
}

type Fn = (input: unknown, args: Node[]) => Generator<unknown>;

const one = (args: Node[], input: unknown): unknown[] => [...run(args[0], input)];

const FUNCS: Record<string, Fn> = {
  *length(v) {
    if (v === null) yield 0;
    else if (typeof v === "string" || Array.isArray(v)) yield v.length;
    else if (isObj(v)) yield Object.keys(v).length;
    else if (typeof v === "number") yield Math.abs(v);
    else fail(`${typeOf(v)} (${brief(v)}) has no length`);
  },
  *keys(v) {
    if (Array.isArray(v)) yield v.map((_, i) => i);
    else if (isObj(v)) yield Object.keys(v).sort();
    else fail(`${typeOf(v)} (${brief(v)}) has no keys`);
  },
  *values(v) {
    if (v !== null) yield v;
  },
  *map(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.flatMap((x) => [...run(a[0], x)]);
  },
  *select(v, a) {
    for (const c of run(a[0], v)) if (truthy(c)) yield v;
  },
  *empty() {
    /* nothing */
  },
  *not(v) {
    yield !truthy(v);
  },
  *first(v, a) {
    if (a.length) {
      for (const x of run(a[0], v)) return yield x;
      return;
    }
    if (!Array.isArray(v)) return fail(`Cannot index ${typeOf(v)} with number`);
    yield v[0] ?? null;
  },
  *last(v, a) {
    if (a.length) {
      let l: unknown;
      let any = false;
      for (const x of run(a[0], v)) (l = x), (any = true);
      if (any) yield l;
      return;
    }
    if (!Array.isArray(v)) return fail(`Cannot index ${typeOf(v)} with number`);
    yield v.length ? v[v.length - 1] : null;
  },
  *sort(v) {
    if (!Array.isArray(v)) return fail(`${typeOf(v)} (${brief(v)}) cannot be sorted, as it is not an array`);
    yield [...v].sort(order);
  },
  *sort_by(v, a) {
    if (!Array.isArray(v)) return fail(`${typeOf(v)} (${brief(v)}) cannot be sorted, as it is not an array`);
    yield v.map((x) => [one(a, x), x] as const).sort((p, q) => order(p[0], q[0])).map((p) => p[1]);
  },
  *group_by(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot group ${typeOf(v)}`);
    const sorted = v.map((x) => [one(a, x), x] as const).sort((p, q) => order(p[0], q[0]));
    const out: unknown[][] = [];
    sorted.forEach((p, i) => (i && same(p[0], sorted[i - 1][0]) ? out[out.length - 1].push(p[1]) : out.push([p[1]])));
    yield out;
  },
  *unique(v) {
    if (!Array.isArray(v)) return fail(`${typeOf(v)} (${brief(v)}) cannot be sorted, as it is not an array`);
    yield [...v].sort(order).filter((x, i, s) => !i || !same(x, s[i - 1]));
  },
  *reverse(v) {
    if (typeof v === "string") yield [...v].reverse().join("");
    else if (Array.isArray(v)) yield [...v].reverse();
    else if (v === null) yield [];
    else fail(`Cannot reverse ${typeOf(v)}`);
  },
  *add(v) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.reduce((acc: unknown, x) => arith("+", acc, x), null);
  },
  *min(v) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.length ? v.reduce((m, x) => (order(x, m) < 0 ? x : m)) : null;
  },
  *max(v) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.length ? v.reduce((m, x) => (order(x, m) >= 0 ? x : m)) : null;
  },
  *min_by(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.length ? v.map((x) => [one(a, x), x] as const).reduce((m, p) => (order(p[0], m[0]) < 0 ? p : m))[1] : null;
  },
  *max_by(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.length ? v.map((x) => [one(a, x), x] as const).reduce((m, p) => (order(p[0], m[0]) >= 0 ? p : m))[1] : null;
  },
  *has(v, a) {
    for (const k of run(a[0], v)) {
      if (isObj(v) && typeof k === "string") yield k in v;
      else if (Array.isArray(v) && typeof k === "number") yield k >= 0 && k < v.length;
      else fail(`Cannot check whether ${typeOf(v)} has a ${typeOf(k)} key`);
    }
  },
  *contains(v, a) {
    const has = (x: unknown, y: unknown): boolean => {
      if (isObj(x) && isObj(y)) return Object.keys(y).every((k) => k in x && has(x[k], y[k]));
      if (Array.isArray(x) && Array.isArray(y)) return y.every((e) => x.some((f) => has(f, e)));
      if (typeof x === "string" && typeof y === "string") return x.includes(y);
      return same(x, y);
    };
    for (const y of run(a[0], v)) yield has(v, y);
  },
  *startswith(v, a) {
    for (const s of run(a[0], v)) typeof v === "string" && typeof s === "string" ? yield v.startsWith(s) : fail("startswith() requires string inputs");
  },
  *endswith(v, a) {
    for (const s of run(a[0], v)) typeof v === "string" && typeof s === "string" ? yield v.endsWith(s) : fail("endswith() requires string inputs");
  },
  *test(v, a) {
    if (typeof v !== "string") return fail(`${typeOf(v)} (${brief(v)}) cannot be matched, as it is not a string`);
    for (const re of run(a[0], v)) {
      let rx: RegExp;
      try {
        rx = new RegExp(String(re), a[1] ? String([...run(a[1], v)][0] ?? "").replace(/[^imsu]/g, "") : "");
      } catch {
        return fail(`${String(re)} (at offset 0) is not a valid regex`);
      }
      yield rx.test(v);
    }
  },
  *ascii_downcase(v) {
    typeof v === "string" ? yield v.toLowerCase() : fail("ascii_downcase input must be a string");
  },
  *ascii_upcase(v) {
    typeof v === "string" ? yield v.toUpperCase() : fail("ascii_upcase input must be a string");
  },
  *tostring(v) {
    yield typeof v === "string" ? v : JSON.stringify(v);
  },
  *tonumber(v) {
    if (typeof v === "number") yield v;
    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) yield Number(v);
    else fail(`Cannot parse ${brief(v)} as a number`);
  },
  *tojson(v) {
    yield JSON.stringify(v);
  },
  *fromjson(v) {
    try {
      yield JSON.parse(String(v));
    } catch {
      fail(`${brief(v)} is not valid JSON`);
    }
  },
  *type(v) {
    yield typeOf(v);
  },
  *flatten(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    const depth = a.length ? Number([...run(a[0], v)][0]) : Infinity;
    yield v.flat(depth);
  },
  *any(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.some((x) => (a.length ? [...run(a[0], x)].some(truthy) : truthy(x)));
  },
  *all(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield v.every((x) => (a.length ? [...run(a[0], x)].every(truthy) : truthy(x)));
  },
  *join(v, a) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    for (const sep of run(a[0], v)) yield v.map((x) => (x === null ? "" : typeof x === "string" ? x : JSON.stringify(x))).join(String(sep));
  },
  *split(v, a) {
    if (typeof v !== "string") return fail("split input must be a string");
    for (const sep of run(a[0], v)) yield v.split(String(sep));
  },
  *range(v, a) {
    for (const n of run(a[0], v)) for (let i = 0; i < Number(n); i++) yield i;
  },
  *limit(v, a) {
    let left = Number([...run(a[0], v)][0]);
    if (left <= 0) return;
    for (const x of run(a[1], v)) {
      yield x;
      if (--left <= 0) return;
    }
  },
  *to_entries(v) {
    if (!isObj(v)) return fail(`${typeOf(v)} (${brief(v)}) has no keys`);
    yield Object.entries(v).map(([key, value]) => ({ key, value }));
  },
  *from_entries(v) {
    if (!Array.isArray(v)) return fail(`Cannot iterate over ${typeOf(v)}`);
    yield Object.fromEntries(v.map((e: any) => [String(e?.key ?? e?.name ?? e?.k), e?.value ?? e?.v ?? null]));
  },
  *abs(v) {
    typeof v === "number" ? yield Math.abs(v) : fail(`${typeOf(v)} (${brief(v)}) has no absolute value`);
  },
  *floor(v) {
    typeof v === "number" ? yield Math.floor(v) : fail(`${typeOf(v)} (${brief(v)}) number required`);
  },
  *ceil(v) {
    typeof v === "number" ? yield Math.ceil(v) : fail(`${typeOf(v)} (${brief(v)}) number required`);
  },
  *round(v) {
    typeof v === "number" ? yield Math.round(v) : fail(`${typeOf(v)} (${brief(v)}) number required`);
  },
};

const MAX_STEPS = 2_000_000;
let steps = 0;

/** Every value any step produces counts, so a filter that fans out (map(range(n)) inside map) stops early. */
function* run(n: Node, input: unknown): Generator<unknown> {
  if (++steps > MAX_STEPS) fail("The filter is too expensive to run on this response");
  for (const x of runNode(n, input)) {
    if (++steps > MAX_STEPS) fail("The filter is too expensive to run on this response");
    yield x;
  }
}

function* runNode(n: Node, input: unknown): Generator<unknown> {
  switch (n.k) {
    case "id":
      return yield input;
    case "rec":
      return yield* descend(input);
    case "lit":
      return yield n.v;
    case "field":
      for (const b of run(n.of, input)) yield index(b, n.name);
      return;
    case "index":
      for (const b of run(n.of, input)) for (const at of run(n.at, input)) yield index(b, at);
      return;
    case "slice":
      for (const b of run(n.of, input)) {
        if (b === null) {
          yield null;
          continue;
        }
        if (typeof b !== "string" && !Array.isArray(b)) fail(`Cannot index ${typeOf(b)} with object`);
        const from = n.from ? Number([...run(n.from, input)][0]) : 0;
        const to = n.to ? Number([...run(n.to, input)][0]) : b.length;
        yield typeof b === "string" ? b.slice(from, to) : b.slice(from, to);
      }
      return;
    case "iter":
      for (const b of run(n.of, input)) {
        if (Array.isArray(b)) yield* b;
        else if (isObj(b)) yield* Object.values(b);
        else fail(`Cannot iterate over ${typeOf(b)}${b === null ? "" : ` (${brief(b)})`}`);
      }
      return;
    case "try":
      try {
        yield* [...run(n.of, input)];
      } catch (e) {
        if (!(e instanceof FilterError)) throw e;
      }
      return;
    case "pipe":
      for (const x of run(n.a, input)) yield* run(n.b, x);
      return;
    case "comma":
      yield* run(n.a, input);
      return yield* run(n.b, input);
    case "neg":
      for (const x of run(n.a, input)) typeof x === "number" ? yield -x : fail(`${typeOf(x)} (${brief(x)}) cannot be negated`);
      return;
    case "arr":
      return yield n.of ? [...run(n.of, input)] : [];
    case "obj": {
      let parts: Record<string, unknown>[] = [{}];
      for (const [kn, vn] of n.entries) {
        const next: Record<string, unknown>[] = [];
        for (const k of run(kn, input)) {
          if (typeof k !== "string") fail(`Object keys must be strings, not ${typeOf(k)}`);
          for (const v of run(vn, input)) for (const p of parts) next.push({ ...p, [k as string]: v });
        }
        parts = next;
      }
      return yield* parts;
    }
    case "if":
      for (const c of run(n.cond, input)) {
        if (truthy(c)) yield* run(n.then, input);
        else if (n.else) yield* run(n.else, input);
        else yield input;
      }
      return;
    case "call": {
      const f = FUNCS[n.name];
      if (!f) return fail(`${n.name}/${n.args.length} is not defined`);
      return yield* f(input, n.args);
    }
    case "bin": {
      if (n.op === "and" || n.op === "or") {
        for (const a of run(n.a, input)) {
          if (n.op === "and" && !truthy(a)) yield false;
          else if (n.op === "or" && truthy(a)) yield true;
          else for (const b of run(n.b, input)) yield truthy(b);
        }
        return;
      }
      if (n.op === "//") {
        let any = false;
        try {
          for (const a of run(n.a, input)) if (truthy(a)) (any = true), yield a;
        } catch (e) {
          if (!(e instanceof FilterError)) throw e;
        }
        if (!any) yield* run(n.b, input);
        return;
      }
      for (const b of run(n.b, input))
        for (const a of run(n.a, input)) {
          if (n.op === "==") yield same(a, b);
          else if (n.op === "!=") yield !same(a, b);
          else if (n.op === "<") yield order(a, b) < 0;
          else if (n.op === "<=") yield order(a, b) <= 0;
          else if (n.op === ">") yield order(a, b) > 0;
          else if (n.op === ">=") yield order(a, b) >= 0;
          else yield arith(n.op, a, b);
        }
      return;
    }
  }
}

/* -------------------------------- JSONPath ------------------------------- */

type Seg =
  | { s: "child"; names: (string | number)[] }
  | { s: "wild" }
  | { s: "slice"; from: number | null; to: number | null }
  | { s: "filter"; node: Node }
  | { s: "rec" };

function parseJsonPath(src: string): Seg[] {
  const segs: Seg[] = [];
  let i = 1; // after "$"
  const ident = () => /^[^.[\]\s]+/.exec(src.slice(i))?.[0] ?? "";
  while (i < src.length) {
    if (src.startsWith("..", i)) {
      segs.push({ s: "rec" });
      i += 2;
      if (src[i] === "[") continue;
      if (src[i] === "*") (segs.push({ s: "wild" }), i++);
      else {
        const id = ident();
        if (!id) fail('Expected a name after ".."');
        segs.push({ s: "child", names: [id] });
        i += id.length;
      }
    } else if (src[i] === ".") {
      i++;
      if (src[i] === "*") (segs.push({ s: "wild" }), i++);
      else {
        const id = ident();
        if (!id) fail('Expected a name after "."');
        segs.push({ s: "child", names: [id] });
        i += id.length;
      }
    } else if (src[i] === "[") {
      let depth = 0;
      let j = i;
      let quote = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") depth++;
        else if (c === "]" && --depth === 0) break;
      }
      if (j >= src.length) fail('Missing "]"');
      const inner = src.slice(i + 1, j).trim();
      i = j + 1;
      if (inner === "*") segs.push({ s: "wild" });
      else if (inner.startsWith("?")) {
        const body = inner.slice(1).trim().replace(/^\((.*)\)$/s, "$1");
        const js = body.replace(/&&/g, " and ").replace(/\|\|/g, " or ").replace(/@/g, ".").replace(/\.\.(?=[A-Za-z_])/g, ".");
        const p = new Parser(tokenize(js));
        const node = p.pipe();
        p.done();
        segs.push({ s: "filter", node });
      } else if (/^-?\d*:-?\d*$/.test(inner)) {
        const [a, b] = inner.split(":");
        segs.push({ s: "slice", from: a === "" ? null : Number(a), to: b === "" ? null : Number(b) });
      } else {
        const names = inner.split(/,(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/).map((x) => {
          const t = x.trim();
          if (/^-?\d+$/.test(t)) return Number(t);
          if (/^(['"]).*\1$/s.test(t)) return t.slice(1, -1);
          return fail(`Unsupported selector ${t}`);
        });
        segs.push({ s: "child", names });
      }
    } else fail(`Unexpected "${src[i]}"`);
  }
  return segs;
}

function runJsonPath(data: unknown, src: string): unknown[] {
  let cur: unknown[] = [data];
  for (const seg of parseJsonPath(src)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (seg.s === "rec") next.push(...descend(v));
      else if (seg.s === "wild") {
        if (Array.isArray(v)) next.push(...v);
        else if (isObj(v)) next.push(...Object.values(v));
      } else if (seg.s === "child") {
        for (const n of seg.names) {
          if (typeof n === "number" && Array.isArray(v)) {
            const x = v[n < 0 ? v.length + n : n];
            if (x !== undefined) next.push(x);
          } else if (isObj(v) && String(n) in v) next.push(v[String(n)]);
          else if (Array.isArray(v) && typeof n === "string" && /^\d+$/.test(n) && v[Number(n)] !== undefined) next.push(v[Number(n)]);
        }
      } else if (seg.s === "slice") {
        if (Array.isArray(v)) next.push(...v.slice(seg.from ?? 0, seg.to ?? v.length));
      } else {
        const items = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
        for (const x of items) {
          let ok = false;
          try {
            for (const r of run(seg.node, x)) if (truthy(r)) ok = true;
          } catch (e) {
            if (!(e instanceof FilterError)) throw e;
          }
          if (ok) next.push(x);
        }
      }
    }
    cur = next;
  }
  return cur;
}

/* ---------------------------------- API ---------------------------------- */

/** Run a JSONPath (starts with `$`) or jq-style filter against parsed JSON. Never throws. */
export function runFilter(data: unknown, expr: string): FilterResult {
  const src = expr.trim();
  steps = 0;
  if (!src) return { ok: true, values: [data], syntax: "jq" };
  try {
    if (src.startsWith("$")) return { ok: true, values: runJsonPath(data, src), syntax: "jsonpath" };
    const p = new Parser(tokenize(src));
    const node = p.pipe();
    p.done();
    return { ok: true, values: [...run(node, data)], syntax: "jq" };
  } catch (e) {
    if (e instanceof FilterError) return { ok: false, error: e.message };
    if (e instanceof RangeError) return { ok: false, error: "The filter is too deeply nested" };
    throw e;
  }
}

/** The text to show for a result: one JSON value per line when there are several (like jq), indented. */
export function formatFilterValues(values: unknown[]): string {
  return values.map((v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, null, 2) ?? "null")).join("\n");
}
