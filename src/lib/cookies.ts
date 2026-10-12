import { invoke } from "@tauri-apps/api/core";

export type Cookie = { domain: string; path: string; name: string; value: string; secure: boolean; httpOnly: boolean; expires: string | null };

export const listCookies = () => invoke<Cookie[]>("cookies_list");
export const deleteCookie = (c: Pick<Cookie, "domain" | "path" | "name">) => invoke("cookies_delete", { domain: c.domain, path: c.path, name: c.name });
export const clearCookies = (domain?: string) => invoke("cookies_clear", { domain: domain ?? null });
export const addCookie = (c: Pick<Cookie, "domain" | "path" | "name" | "value">) => invoke("cookies_add", c);

/** Parse one Set-Cookie header into name/value + the attributes worth showing. */
export function parseSetCookie(header: string) {
  const [pair, ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const out = { name: eq < 0 ? pair : pair.slice(0, eq), value: eq < 0 ? "" : pair.slice(eq + 1), attrs: [] as string[] };
  out.attrs = attrs.filter(Boolean);
  return out;
}
