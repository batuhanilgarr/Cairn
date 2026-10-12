/**
 * Node implementations of the Tauri commands the shared libraries call, so the CLI runs the exact same
 * pipeline (inheritance, scripts, OAuth, assertions) as the app. Behaviour mirrors src-tauri/src/lib.rs.
 */
import fs from "node:fs";
import path from "node:path";
import { sendHttp } from "../src/http";

const fwd = (p: string) => p.split(path.sep).join("/");

function walk(dir: string, suffix: string, out: string[]) {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, suffix, out);
    else if (e.name.endsWith(suffix)) out.push(fwd(p));
  }
}

export async function invoke<T>(cmd: string, args: any = {}): Promise<T> {
  switch (cmd) {
    case "send_request":
      return (await sendHttp(args.spec)) as T;
    case "read_text":
      try {
        return fs.readFileSync(args.path, "utf8") as T;
      } catch (e: any) {
        if (e.code === "ENOENT") return null as T;
        throw e;
      }
    case "write_text":
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      fs.writeFileSync(args.path, args.content);
      return undefined as T;
    case "path_exists":
      return fs.existsSync(args.path) as T;
    case "make_dir":
      fs.mkdirSync(args.path, { recursive: true });
      return undefined as T;
    case "remove_path":
      fs.rmSync(args.path, { recursive: true, force: true });
      return undefined as T;
    case "list_files": {
      let names: string[] = [];
      try {
        names = fs.readdirSync(args.dir);
      } catch {
        /* missing folder: empty */
      }
      return names.filter((n) => n.endsWith(args.suffix) && !n.startsWith(".")).sort().map((n) => fwd(path.join(args.dir, n))) as T;
    }
    case "list_files_recursive": {
      const out: string[] = [];
      walk(args.dir, args.suffix, out);
      return out.sort() as T;
    }
    case "oauth_listen":
      throw new Error("Browser sign-in isn't available in the CLI. Use the client-credentials grant, or pass a token with --var token=…");
    default:
      throw new Error(`The CLI doesn't support "${cmd}"`);
  }
}
