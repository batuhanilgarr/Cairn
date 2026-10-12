import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
