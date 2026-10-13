import type { KV } from "./types";
import { emptyKV } from "./util";

/**
 * The URL is the single source of truth for enabled query parameters; the Params table is a view of it
 * (plus rows you switched off, which only live in the table). Typing `?a=1` adds a row, editing a row rewrites the URL.
 */
type Pair = { raw: string; key: string; value: string };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Encode, but leave {{variables}} alone so they are still filled in when the request is sent. */
const enc = (s: string) => s.split(/(\{\{[^}]*\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join("");

export function splitUrl(url: string): { base: string; query: string; hash: string } {
  const h = url.indexOf("#");
  const hash = h >= 0 ? url.slice(h) : "";
  const rest = h >= 0 ? url.slice(0, h) : url;
  const q = rest.indexOf("?");
  return q >= 0 ? { base: rest.slice(0, q), query: rest.slice(q + 1), hash } : { base: rest, query: "", hash };
}

function pairsOf(query: string): Pair[] {
  return query
    .split("&")
    .filter(Boolean)
    .map((raw) => {
      const i = raw.indexOf("=");
      return { raw, key: dec(i < 0 ? raw : raw.slice(0, i)), value: i < 0 ? "" : dec(raw.slice(i + 1)) };
    });
}

const live = (rows: KV[]) => rows.filter((r) => r.enabled && r.key);

/** Enabled rows that the URL doesn't contain yet (rows from older files or importers, which only had the table). */
export function missingParams(url: string, rows: KV[]): KV[] {
  const have = pairsOf(splitUrl(url).query);
  return live(rows).filter((r) => {
    const i = have.findIndex((p) => p.key === r.key && p.value === r.value);
    if (i < 0) return true;
    have.splice(i, 1);
    return false;
  });
}

/** Put every enabled row into the URL's query string (rows already there are left as typed). */
export function foldParamsIntoUrl(url: string, rows: KV[]): string {
  const add = missingParams(url, rows);
  if (!add.length) return url;
  const { base, query, hash } = splitUrl(url);
  const extra = add.map((r) => `${enc(r.key)}=${enc(r.value)}`).join("&");
  return `${base}?${query ? query + "&" : ""}${extra}${hash}`;
}

/** The table for a URL: its query pairs as enabled rows (keeping row ids so inputs keep focus), then the disabled rows. */
export function rowsFromUrl(url: string, prev: KV[]): KV[] {
  const used = new Set<string>();
  const rows = pairsOf(splitUrl(url).query).map((p) => {
    const hit = prev.find((r) => r.enabled && !used.has(r.id) && r.key === p.key && r.value === p.value) ?? prev.find((r) => r.enabled && !used.has(r.id) && r.key === p.key);
    if (hit) used.add(hit.id);
    const e = emptyKV();
    return { ...e, id: hit?.id ?? e.id, key: p.key, value: p.value, enabled: true };
  });
  return [...rows, ...prev.filter((r) => !r.enabled && r.key), emptyKV()];
}

/** Rewrite the URL's query from the table's enabled rows. Pairs you didn't change keep their original text. */
export function urlFromRows(url: string, rows: KV[]): string {
  const { base, query, hash } = splitUrl(url);
  const old = pairsOf(query);
  const parts = live(rows).map((r) => {
    const i = old.findIndex((p) => p.key === r.key && p.value === r.value);
    if (i >= 0) return old.splice(i, 1)[0].raw;
    return `${enc(r.key)}=${enc(r.value)}`;
  });
  return `${base}${parts.length ? "?" + parts.join("&") : ""}${hash}`;
}

/** Bring a request's url and table in line: fold in table-only rows, then derive the table from the URL. */
export function syncParams(url: string, rows: KV[]): { url: string; params: KV[] } {
  const next = foldParamsIntoUrl(url, rows);
  return { url: next, params: rowsFromUrl(next, rows) };
}
