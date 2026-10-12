import type { AuthMode, BodyMode, KV } from "./types";
import { emptyKV, newTab, tryPrettyJson } from "./util";
import type { ImportResult, ImportedRequest } from "./openapi";

type Obj = Record<string, any>;

const rows = (list: any): KV[] => [
  ...(Array.isArray(list) ? list : [])
    .filter((r: Obj) => r?.key)
    .map((r: Obj) => ({ ...emptyKV(), key: String(r.key), value: String(r.value ?? ""), enabled: !r.disabled })),
  emptyKV(),
];

const authField = (arr: any, key: string): string =>
  String((Array.isArray(arr) ? arr.find((a: Obj) => a.key === key)?.value : undefined) ?? "");

/** Postman Collection v2.0 / v2.1 */
export function parsePostman(text: string): ImportResult {
  const col: Obj = JSON.parse(text);
  if (!col?.info || !Array.isArray(col.item)) throw new Error("This doesn't look like a Postman collection (v2.x JSON).");
  const notes: string[] = [];
  const requests: ImportedRequest[] = [];

  const walk = (items: Obj[], folder: string[]) => {
    for (const it of items) {
      if (Array.isArray(it.item)) {
        walk(it.item, [...folder, String(it.name ?? "folder")]);
        continue;
      }
      const r: Obj = it.request ?? {};
      const t = newTab();
      t.name = String(it.name ?? "Request");
      t.method = String(r.method ?? "GET").toUpperCase();
      t.url = typeof r.url === "string" ? r.url : String(r.url?.raw ?? "");
      t.headers = rows(r.header);

      const b: Obj | undefined = r.body;
      let mode: BodyMode = "none";
      if (b?.mode === "raw") {
        const lang = b.options?.raw?.language;
        const isJson = lang === "json" || tryPrettyJson(String(b.raw ?? "")) !== null;
        mode = isJson ? "json" : "text";
        t.body = String(b.raw ?? "");
      } else if (b?.mode === "urlencoded") {
        mode = "form";
        t.body = (b.urlencoded ?? [])
          .filter((x: Obj) => !x.disabled)
          .map((x: Obj) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? "")}`)
          .join("&");
      } else if (b?.mode === "formdata" || b?.mode === "file" || b?.mode === "graphql") {
        notes.push(`"${t.name}": ${b.mode} bodies aren't supported yet, body left empty`);
      }
      t.bodyMode = mode;

      const a: Obj | undefined = r.auth ?? undefined;
      let am: AuthMode = "none";
      if (a?.type === "bearer") {
        am = "bearer";
        t.authToken = authField(a.bearer, "token");
      } else if (a?.type === "basic") {
        am = "basic";
        t.authUser = authField(a.basic, "username");
        t.authPass = authField(a.basic, "password");
      } else if (a && a.type !== "noauth") notes.push(`"${t.name}": ${a.type} auth isn't supported yet`);
      t.authMode = am;

      requests.push({ folder, base: t.name, tab: t });
    }
  };
  walk(col.item, []);

  const vars: Record<string, string> = {};
  for (const v of col.variable ?? []) if (v?.key) vars[String(v.key)] = String(v.value ?? "");
  return { title: String(col.info.name ?? "Postman import"), vars, requests, notes: [...new Set(notes)] };
}
