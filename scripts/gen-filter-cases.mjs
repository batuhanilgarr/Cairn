// Regenerates tests/fixtures/filter-cases.json from the TypeScript filter engine (src/lib/filter.ts).
// Both engines (TypeScript and src-tauri/src/filter.rs) are tested against this file, so they stay in step.
// Run it when the filter language changes on purpose:  node scripts/gen-filter-cases.mjs
import { build } from "../cli/node_modules/esbuild/lib/main.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-fc-")), "m.mjs");
await build({ entryPoints: [path.join(root, "src/lib/filter.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { runFilter } = await import(out);

const inputs = {
  main: {
    store: { name: "Corner", open: true, tags: ["a", "b"] },
    data: [
      { id: "inv_1", amount: 100, status: "paid", tags: ["a", "b"], price: 9.5 },
      { id: "inv_2", amount: 250, status: "open", tags: [], price: 20 },
      { id: "inv_3", amount: 40, status: "paid", tags: ["c"], price: 5.25 },
    ],
    total: 3,
    nothing: null,
    text: "Hello, World",
    nested: { a: { b: { c: [1, 2, { d: "deep" }] } } },
    mixed: [3, "a", null, true, [1], { k: 1 }, 2.5],
  },
  scalars: { n: -4.5, s: "x", t: true, f: false, z: null, big: 12345678, list: [1, 2, 3, 4, 5], words: ["b", "a", "c", "a"] },
};

const MAIN = [
  "", ".", ".store", ".store.name", ".store.tags[1]", ".data[0].id", ".data[-1].id", ".data[1:3] | map(.id)", ".data[:2] | length", ".data[1:] | length",
  ".data[].id", ".data[] | .amount", '.["store"]["open"]', ".missing", ".nothing.deeper", ".nothing[0]", ".total.x", ".store[0]", ".data.id", '.text | .[0:5]', ".text[7:]",
  ".data | map(.amount) | add", ".data | map(.amount) | max, min", ".data | map(.amount) | max", ".data | sort_by(.amount) | map(.id)", ".data | sort_by(.status, .id) | map(.id)",
  ".data | group_by(.status) | map(length)", ".data | group_by(.status) | map(map(.id))", ".data | length", ".data | map(.tags | length)", ".data | map(.status) | unique", ".data | first | .id", ".data | last | .id",
  ".data | first(.[] | select(.amount > 90)) | .id", ".data | last(.[].id)", ".data | any(.amount > 200)", ".data | all(.amount > 50)", ".data | map(.amount) | any", ".data | min_by(.amount) | .id", ".data | max_by(.amount) | .id",
  '.data | map(select(.status == "paid")) | map(.id)', '.data[] | select(.amount > 90 and .status == "paid") | .id', '.data[] | select(.status == "open" or .amount < 50) | .id', ".data[] | select(.tags | length > 0) | .id",
  '.data[0] | {id, amount, paid: (.status == "paid")}', '.data[0] | {"x": .id, (.status): .amount}', '[.data[].id]', '.data | map({id, big: (.amount >= 100)})', '{a: 1, b: [1, 2]}',
  ".store | keys", ".data[0] | keys", ".data | keys", ".store | to_entries | map(.key)", ".store | to_entries | from_entries", '[{"key":"a","value":1},{"name":"b","v":2}] | from_entries',
  '.data | map(.id) | join(",")', '.data | map(.id) | join(" / ")', '.mixed | join("-")', '.text | split(", ")', '.text | ascii_downcase', '.text | ascii_upcase', '.text | startswith("Hello")', '.text | endswith("x")',
  '.data[] | select(.id | test("_[12]$")) | .id', '.text | test("hello")', '.text | test("hello"; "i")', '.text | test("(")', '.text | contains("World")', '.store | contains({open: true})', '.store | has("name")', '.store | has("nope")', ".data | has(2)", ".data | has(5)",
  '.data[0] | if .amount > 50 then "big" else "small" end', '.data[] | if .amount > 200 then "huge" elif .amount > 50 then "big" else "small" end', ".data[] | if .amount > 200 then .id end",
  '.missing // "fallback"', '.total // "fallback"', ".nothing // .total", "(.missing, .nothing) // 7", "(.data[].amount | select(. > 1000)) // 0",
  ".total + 1", ".total - 1", ".total * 2", ".total / 2", ".total % 2", ".total / 0", ".total % 0", '"a" + "b"', '"ab" * 3', '"a,b" / ","', "[1,2] + [3]", "[1,2,3] - [2]", '{a:1} + {b:2}', ".nothing + 1", "1 + .nothing", '"a" + 1', "-.total", '-"x"',
  ".data[].tags[]?", ".total.x?", ".total | .[]?", ".data[] | .tags[0]?", ".total | .[]", ".data[0] | .[]", ".nothing | .[]",
  "..| .amount? // empty", "[..|numbers?]", "[.. | .id? | select(. != null)]", ".nested.a.b.c[2].d", ".nested | .. | .d? // empty",
  ".mixed | map(type)", ".mixed | sort", ".mixed | sort | map(type)", ".mixed | length", ".mixed | map(tostring)", ".mixed | flatten", ".nested.a.b.c | flatten", "[[1,[2]],[3]] | flatten", "[[1,[2]],[3]] | flatten(1)",
  ".total | tostring", ".text | tostring", ".data[0] | tojson", '"[1,2]" | fromjson', '"nope" | fromjson', '"12" | tonumber', '" 7 " | tonumber', '"x" | tonumber', ".store | type", ".total | type", ".nothing | type",
  "[range(5)]", "[range(2; 4)]", "[limit(2; .data[])] | length", "[limit(0; .data[])] | length", "[.data[] | .amount] | sort | reverse", '"abc" | reverse', ".nothing | reverse", ".total | reverse",
  ".data | map(.price) | map(floor)", ".data | map(.price) | map(ceil)", ".data | map(.price) | map(round)", ".data | map(.price) | add", "-2.5 | round", "2.5 | round", "-7 | abs", '"x" | abs',
  ".nothing | length", ".text | length", ".store | length", ".total | length", "-3 | length", ".store.open | length", ".store.open | keys", ".total | not", ".nothing | not", "null | not",
  ".data | map(.id) | sort", ".data | map(.amount) | sort", ".mixed | unique", ".store | sort", ".store.name | add", ".data | add", "[[1],[2]] | add", '["a","b"] | add', "[] | add", "[] | min", "[] | max",
  ".data[0] | .id, .amount", ".data[0].id, .data[1].id", ".data | map(select(.amount > 50) | .id)", "[.data[] | select(.amount > 50)] | length", ".data | map(.amount) | map(. * 2)", '.data | map(.amount) | map(select(. > 50))',
  "frobnicate", ".data[] | frobnicate(1)", ".data[", ".data[0", ".data |", "| .a", ".a b", '"unterminated', ".data[] | select(", "{a", "{1: 2}", "{(1): 2}", "[1, 2", "if . then 1", "if . then 1 else 2", ".. a", "(.a", ")",
  "1 + ", ".a ?? 1", "map(.a)", ".data | map", ".data | limit(1)", ".data | sort_by", ".data | has", ".data | test(1)", ".data | startswith(\"a\")", ".data | join(\",\")", ".data | split(\",\")", '"a" | has("a")', "1 | has(0)",
  ".data[] | select(.amount > 50) | .id | tostring | length", "[.data[].id | ascii_upcase]", ".data | map(.id | ltrimstr(\"inv_\"))",
  "$", "$.store.name", "$.data[0].id", "$.data[-1].id", "$.data[*].id", "$..id", "$.data[0:2].id", "$.data[1:].id", "$.data[:1].id", "$.data[0,2].id", "$['store']['name']", '$["store"]["name"]', "$.store['name','open']", "$.nope", "$.nope.deeper", "$.total",
  "$.data[?(@.amount > 90)].id", "$.data[?(@.status == 'paid' && @.amount < 50)].id", "$.data[?(@.status == 'open' || @.amount == 40)].id", "$.data[?(@.tags)].id", "$.data[?(@.price < 10)].id", "$.data[?(@.tags[0] == 'a')].id",
  "$.data[?(@.amount >)].id", "$.data[", "$.data[?(@.x ===)]", "$.", "$..", "$.data[0:2]", "$.nested..d", "$.nested.a.b.c[2].d", "$.nested.a.b.c[*]", "$.store.tags[*]", "$.data[*].tags[*]", "$.mixed[*]", "$.data['id']", "$[0]", "$.data.0.id", "$.data[1]['id']", "$.data[?(@.id == 'inv_2')]", "$.data[?(@.amount != 100)].id", "$.data[?(@.amount >= 100 && @.price > 10)].id",
  "$.data[?(!@.tags)].id", "$.data[ 0 ].id", "$.store[ 'name' ]",
];
const SCALARS = [
  ".n", ".n | abs", ".n | floor", ".n | ceil", ".n | round", ".n * 2", ".n + .n", ".n - 0.5", ".big * 1000000", ".big / 7", ".big % 1000", ".s * 0", ".s * -1", '.s * 2.9', ".t and .f", ".t or .f", ".f or .z", ".z and .t", ".t | not", ".z // .f // 1", ".f // empty", "[.list[] | select(. > 2)]", ".list | add / length",
  ".list[1:3]", ".list[-2:]", ".list[:-2]", ".list[10:]", ".list[2:1]", ".list | .[1.5]", ".list | .[-1]", ".list | .[-9]", ".words | unique", ".words | sort", ".words | group_by(.)", ".words | map(ascii_upcase) | join(\"\")", ".words | index(\"a\")", ".words | min", ".words | max", ".list | map(. * .) | add",
  ".list | map(select(. % 2 == 0))", ".list | any(. > 4)", ".list | all(. > 0)", ".list | flatten", ".list | length", "[.list[] | tostring]", ".list | map(tostring) | join(\"+\")", ".t == true", ".f == false", ".z == null", ".s == \"x\"", ".n < 0", ".n >= -4.5", ".list == [1,2,3,4,5]", ".list != [1]", "[] == []", "{} == {}", "{a:1} == {a:1}", "[1,2] < [1,3]", "[1] < [1,0]", '"a" < "b"', "null < false", "false < true", "true < 0", "0 < \"a\"", "\"a\" < []", "[] < {}",
  "{b: 2, a: 1} | keys", "{b: 2, a: 1} | to_entries | map(.key)", "[{a:1,b:2},{a:1,b:1}] | sort_by(.a, .b) | map(.b)", "[{a:1,b:2},{a:1,b:1}] | sort", "[3,1,2] | sort | reverse", "[[2,1],[1,2],[1]] | sort", "[1,[1],\"1\",null,true,{}] | sort | map(type)", "[1,1,2,2,3] | unique | length",
  "1e3", "1.5e-2 * 100", ".5 + .5", "1 + 2 * 3", "(1 + 2) * 3", "10 / 4", "10 % 4", "-10 % 4", "1 - 2 - 3", "2 * 3 % 4", "[1,2,3] | .[1]", "\"héllo wörld\" | length", "\"héllo\" | .[1:3]", "\"héllo\" | reverse", "\"héllo\" | ascii_upcase", "\"a\\nb\" | length",
];

const cases = [];
for (const [input, exprs] of [["main", MAIN], ["scalars", SCALARS]]) {
  for (const expr of exprs) {
    const r = runFilter(inputs[input], expr);
    cases.push(r.ok ? { input, expr, ok: true, syntax: r.syntax, values: r.values } : { input, expr, ok: false, error: r.error });
  }
}
fs.writeFileSync(path.join(root, "tests/fixtures/filter-cases.json"), JSON.stringify({ inputs, cases }, null, 1) + "\n");
console.log(`${cases.length} cases (${cases.filter((c) => c.ok).length} ok, ${cases.filter((c) => !c.ok).length} errors)`);
