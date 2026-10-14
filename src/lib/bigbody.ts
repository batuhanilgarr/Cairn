import { invoke } from "@tauri-apps/api/core";

/** Wrappers for the Rust-held big response bodies (src-tauri/src/bigbody.rs). */

export type Prepared = { lines: number; bytes: number; pretty: boolean };
export type Found = { total: number; capped: boolean; lines: number[] };

export const bodyPrepare = (id: number) => invoke<Prepared>("body_prepare", { id });
export const bodyLines = (id: number, start: number, count: number) => invoke<string[]>("body_lines", { id, start, count });
export const bodySearch = (id: number, query: string, caseSensitive: boolean) => invoke<Found>("body_search", { id, query, caseSensitive });
export const bodySave = (id: number, path: string) => invoke<void>("body_save", { id, path });
export const bodyText = (id: number) => invoke<string>("body_text", { id });

/** The full text of a response, fetched from Rust when it was too big to ship to the page. */
export async function fullBody(r: { body: string; bodyId?: number | null }): Promise<string> {
  return r.bodyId != null ? bodyText(r.bodyId) : r.body;
}
