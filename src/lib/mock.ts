import { invoke } from "@tauri-apps/api/core";
import { listFilesRecursive } from "./fs";
import { readRequest } from "./collection";

export type MockRoute = {
  method: string;
  path: string;
  name: string;
  examples: { name: string; status: number; headers: [string, string][]; body: string; delayMs: number }[];
};

/** "{{baseUrl}}/users/{{id}}?x=1" or "https://api.dev/users/1" -> "/users/{{id}}" / "/users/1" */
export function pathOf(url: string): string {
  let u = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/^\{\{[^}]*\}\}/, "");
  if (!u.startsWith("/")) u = "/" + u;
  return u.split("?")[0].split("#")[0] || "/";
}

/** Every HTTP/GraphQL request in the collection becomes a route; its saved examples are what the mock answers with. */
export async function buildRoutes(root: string, includeEmpty: boolean): Promise<MockRoute[]> {
  const routes: MockRoute[] = [];
  for (const file of await listFilesRecursive(root, ".req.yaml")) {
    const t = await readRequest(file).catch(() => null);
    if (!t) continue;
    if (t.kind !== "http" && t.kind !== "graphql") continue;
    if (!t.examples.length && !includeEmpty) continue;
    routes.push({
      method: t.kind === "graphql" ? "POST" : t.method,
      path: pathOf(t.url),
      name: t.name,
      examples: t.examples.map((e) => ({
        name: e.name,
        status: e.status,
        headers: e.headers.filter((h) => h.key && h.enabled).map((h) => [h.key, h.value] as [string, string]),
        body: e.body,
        delayMs: e.delayMs,
      })),
    });
  }
  return routes;
}

export const mockStart = (port: number, routes: MockRoute[]) => invoke<number>("mock_start", { port, routes });
export const mockStop = () => invoke("mock_stop");

export type MockHit = { n: number; at: number; method: string; path: string; status: number; route: string | null; example?: string | null; ms: number };
