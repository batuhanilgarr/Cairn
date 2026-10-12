import type { KV, RequestTab } from "./types";

export type Layer = { label: string; defaults: RequestTab };

export type Effective = {
  tab: RequestTab;
  pre: string[];
  post: string[];
  /** Inherited headers with where they came from, for display. */
  inheritedHeaders: { key: string; value: string; from: string; overridden: boolean }[];
  /** Where the auth came from when the request says "inherit". */
  authFrom: string | null;
};

const lk = (k: string) => k.trim().toLowerCase();

/**
 * Resolve a request against the defaults of its folders (outermost first).
 *  - headers: deeper levels override shallower ones; a request header with the same name overrides
 *    inherited ones, and a *disabled* request header with that name switches the inherited one off
 *  - auth: "inherit" takes the nearest level that sets auth
 *  - scripts: pre/post scripts run outermost first, then the request's own
 */
export function applyDefaults(tab: RequestTab, layers: Layer[]): Effective {
  const merged = new Map<string, { row: KV; from: string }>();
  for (const l of layers)
    for (const r of l.defaults.headers) {
      if (!r.key) continue;
      // in order, so a deeper level can both override and switch off what an outer level set
      if (r.enabled) merged.set(lk(r.key), { row: r, from: l.label });
      else merged.delete(lk(r.key));
    }

  const inheritedHeaders: Effective["inheritedHeaders"] = [];
  const own = new Map(tab.headers.filter((h) => h.key).map((h) => [lk(h.key), h]));
  const effectiveInherited: KV[] = [];
  for (const [k, { row, from }] of merged) {
    const o = own.get(k);
    inheritedHeaders.push({ key: row.key, value: row.value, from, overridden: !!o });
    if (!o) effectiveInherited.push(row);
  }

  let { authMode, authToken, authUser, authPass, oauth } = tab;
  let authFrom: string | null = null;
  if (authMode === "inherit") {
    authMode = "none";
    for (const l of [...layers].reverse()) {
      const d = l.defaults;
      if (d.authMode !== "none" && d.authMode !== "inherit") {
        ({ authMode, authToken, authUser, authPass, oauth } = d);
        authFrom = l.label;
        break;
      }
    }
  }

  return {
    tab: { ...tab, headers: [...effectiveInherited, ...tab.headers], authMode, authToken, authUser, authPass, oauth },
    pre: [...layers.map((l) => l.defaults.preScript), tab.preScript].filter((s) => s.trim()),
    post: [...layers.map((l) => l.defaults.postScript), tab.postScript].filter((s) => s.trim()),
    inheritedHeaders,
    authFrom,
  };
}
