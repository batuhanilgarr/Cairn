import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { TreeNode } from "./types";

export const listTree = (root: string) => invoke<TreeNode[]>("list_tree", { root });
export const listFiles = (dir: string, suffix: string) => invoke<string[]>("list_files", { dir, suffix });
export const listFilesRecursive = (dir: string, suffix: string) =>
  invoke<string[]>("list_files_recursive", { dir, suffix });
export const readText = (path: string) => invoke<string | null>("read_text", { path });
export const writeText = (path: string, content: string) => invoke<void>("write_text", { path, content });
export const makeDir = (path: string) => invoke<void>("make_dir", { path });
export const removePath = (path: string) => invoke<void>("remove_path", { path });
export const renamePath = (from: string, to: string) => invoke<void>("rename_path", { from, to });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

export async function pickFile(title: string, extensions: string[]): Promise<string | null> {
  const r = await open({ multiple: false, directory: false, title, filters: [{ name: "Files", extensions }] });
  return typeof r === "string" ? r : null;
}

export async function pickFolder(title: string): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title, canCreateDirectories: true });
  return typeof r === "string" ? r : null;
}

export const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Ask where to save, then write the response body. Returns the chosen path, or null if cancelled. */
export async function saveResponse(name: string, body: { base64?: string | null; text?: string; bodyId?: number | null }): Promise<string | null> {
  const path = await saveDialog({ defaultPath: name, title: "Save response" });
  if (!path) return null;
  if (body.bodyId != null) {
    await invoke("body_save", { id: body.bodyId, path });
    return path;
  }
  await invoke("save_bytes", { path, base64: body.base64 ?? null, text: body.base64 ? null : (body.text ?? "") });
  return path;
}

/** Pick any file (for multipart uploads and raw binary bodies). */
export async function pickAnyFile(title: string): Promise<string | null> {
  const r = await open({ multiple: false, directory: false, title });
  return typeof r === "string" ? r : null;
}
