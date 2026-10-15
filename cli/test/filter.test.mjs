import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let F;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-f-")), "m.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/filter.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  F = await import(out);
});

const data = {
  store: { name: "Corner", open: true },
  data: [
    { id: "inv_1", amount: 100, status: "paid", tags: ["a", "b"] },
    { id: "inv_2", amount: 250, status: "open", tags: [] },
    { id: "inv_3", amount: 40, status: "paid", tags: ["c"] },
  ],
  total: 3,
  nothing: null,
};
const jq = (e) => {
  const r = F.runFilter(data, e);
  assert.ok(r.ok, `${e}: ${r.error}`);
  return r.values;
};
const jp = jq;
const bad = (e) => {
  const r = F.runFilter(data, e);
  assert.equal(r.ok, false, `${e} should fail`);
  return r.error;
};

test("an empty filter returns the document", () => assert.deepEqual(jq(""), [data]));

test("jq: paths, indexes, slices and iteration", () => {
  assert.deepEqual(jq(".store.name"), ["Corner"]);
  assert.deepEqual(jq(".data[0].id"), ["inv_1"]);
  assert.deepEqual(jq(".data[-1].id"), ["inv_3"]);
  assert.deepEqual(jq(".data[1:3] | map(.id)"), [["inv_2", "inv_3"]]);
  assert.deepEqual(jq(".data[].id"), ["inv_1", "inv_2", "inv_3"]);
  assert.deepEqual(jq('.["store"]["open"]'), [true]);
  assert.deepEqual(jq(".missing"), [null]);
  assert.deepEqual(jq(".nothing.deeper"), [null]);
  assert.deepEqual(jq("[..| .amount? // empty]"), [[100, 250, 40]]);
});

test("jq: select, map, sort, group and aggregates", () => {
  assert.deepEqual(jq('.data | map(select(.status == "paid")) | map(.id)'), [["inv_1", "inv_3"]]);
  assert.deepEqual(jq(".data[] | select(.amount > 90 and .status == \"paid\") | .id"), ["inv_1"]);
  assert.deepEqual(jq(".data | map(.amount) | add"), [390]);
  assert.deepEqual(jq(".data | map(.amount) | max, min"), [250, 40]);
  assert.deepEqual(jq(".data | sort_by(.amount) | map(.id)"), [["inv_3", "inv_1", "inv_2"]]);
  assert.deepEqual(jq(".data | group_by(.status) | map(length)"), [[1, 2]]);
  assert.deepEqual(jq(".data | length"), [3]);
  assert.deepEqual(jq(".data | map(.tags | length)"), [[2, 0, 1]]);
  assert.deepEqual(jq(".data | map(.status) | unique"), [["open", "paid"]]);
  assert.deepEqual(jq(".data | first | .id"), ["inv_1"]);
  assert.deepEqual(jq(".data | last | .id"), ["inv_3"]);
  assert.deepEqual(jq(".data | any(.amount > 200)"), [true]);
  assert.deepEqual(jq(".data | all(.amount > 50)"), [false]);
});

test("jq: construction, strings, keys, conditionals, alternatives", () => {
  assert.deepEqual(jq(".data[0] | {id, amount, paid: (.status == \"paid\")}"), [{ id: "inv_1", amount: 100, paid: true }]);
  assert.deepEqual(jq("[.data[].id]"), [["inv_1", "inv_2", "inv_3"]]);
  assert.deepEqual(jq(".store | keys"), [["name", "open"]]);
  assert.deepEqual(jq(".data | map(.id) | join(\",\")"), ["inv_1,inv_2,inv_3"]);
  assert.deepEqual(jq('.data[] | select(.id | test("_[12]$")) | .id'), ["inv_1", "inv_2"]);
  assert.deepEqual(jq('.data[0] | if .amount > 50 then "big" else "small" end'), ["big"]);
  assert.deepEqual(jq('.missing // "fallback"'), ["fallback"]);
  assert.deepEqual(jq(".total + 1"), [4]);
  assert.deepEqual(jq('.store.name | ascii_upcase | startswith("CORN")'), [true]);
  assert.deepEqual(jq(".data | map(.amount) | map(. * 2)"), [[200, 500, 80]]);
  assert.deepEqual(jq(".store | to_entries | map(.key)"), [["name", "open"]]);
  assert.deepEqual(jq(".data[].tags[]?"), ["a", "b", "c"]);
});

test("jq: errors are reported, not thrown", () => {
  assert.match(bad(".total.x"), /Cannot index number/);
  assert.match(bad(".data[] | frobnicate"), /frobnicate\/0 is not defined/);
  assert.match(bad(".data["), /Expected/);
  assert.match(bad(".total | .[]"), /Cannot iterate over number/);
  assert.match(bad('"unterminated'), /Unterminated/);
  assert.equal(jq(".total.x?").length, 0);
});

test("JSONPath: names, indexes, wildcards, recursion, slices", () => {
  assert.deepEqual(jp("$.store.name"), ["Corner"]);
  assert.deepEqual(jp("$.data[0].id"), ["inv_1"]);
  assert.deepEqual(jp("$.data[-1].id"), ["inv_3"]);
  assert.deepEqual(jp("$.data[*].id"), ["inv_1", "inv_2", "inv_3"]);
  assert.deepEqual(jp("$..id"), ["inv_1", "inv_2", "inv_3"]);
  assert.deepEqual(jp("$.data[0:2].id"), ["inv_1", "inv_2"]);
  assert.deepEqual(jp("$.data[0,2].id"), ["inv_1", "inv_3"]);
  assert.deepEqual(jp("$['store']['name']"), ["Corner"]);
  assert.deepEqual(jp("$.store['name','open']"), ["Corner", true]);
  assert.deepEqual(jp("$.nope"), []);
  assert.equal(F.runFilter(data, "$.total").syntax, "jsonpath");
});

test("JSONPath: filter expressions", () => {
  assert.deepEqual(jp("$.data[?(@.amount > 90)].id"), ["inv_1", "inv_2"]);
  assert.deepEqual(jp("$.data[?(@.status == 'paid' && @.amount < 50)].id"), ["inv_3"]);
  assert.deepEqual(jp("$.data[?(@.status == 'open' || @.amount == 40)].id"), ["inv_2", "inv_3"]);
  assert.deepEqual(jp("$.data[?(@.tags)].id").length, 3);
  assert.match(bad("$.data[?(@.amount >)].id"), /Expected|Unexpected/);
  assert.match(bad("$.data["), /Missing/);
});

test("output formatting: one value per line, strings quoted, objects indented", () => {
  assert.equal(F.formatFilterValues(["a", 1]), '"a"\n1');
  assert.equal(F.formatFilterValues([{ a: 1 }]), '{\n  "a": 1\n}');
  assert.equal(F.formatFilterValues([]), "");
});

test("a runaway filter stops instead of hanging", () => {
  const t = Date.now();
  const r = F.runFilter(null, "[range(3000)] | map(range(3000)) | length");
  assert.equal(r.ok, false);
  assert.match(r.error, /too expensive/);
  assert.ok(Date.now() - t < 5000);
  // and a normal-sized one still works afterwards (the budget resets per run)
  assert.deepEqual(F.runFilter(null, "[range(10)] | length").values, [10]);
});

test("the shared vectors: this engine answers exactly as recorded (the Rust engine is tested against the same file)", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/filter-cases.json"), "utf8"));
  assert.ok(doc.cases.length > 300);
  const bad = [];
  for (const c of doc.cases) {
    const r = F.runFilter(doc.inputs[c.input], c.expr);
    if (c.ok) {
      if (!r.ok || JSON.stringify(r.values) !== JSON.stringify(c.values) || r.syntax !== c.syntax) bad.push(`${c.expr}: ${r.ok ? JSON.stringify(r.values) : r.error}`);
    } else if (r.ok || r.error !== c.error) bad.push(`${c.expr}: expected the error "${c.error}", got ${r.ok ? JSON.stringify(r.values) : r.error}`);
  }
  assert.deepEqual(bad, [], "the TypeScript engine no longer matches the shared vectors: if the change is on purpose run `node scripts/gen-filter-cases.mjs` and make the Rust engine do the same");
});

test("a function called with the wrong number of arguments is a clean error, not a crash", () => {
  for (const e of [".data | map", ".data | limit(1)", ".data | sort_by", "length(1)", ".[] | range(1; 2)"]) {
    const r = F.runFilter({ data: [1] }, e);
    assert.equal(r.ok, false, e);
    assert.match(r.error, /is not defined/, e);
  }
});
