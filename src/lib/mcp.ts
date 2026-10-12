import { invoke } from "@tauri-apps/api/core";

export type McpTool = { name: string; title?: string; description?: string; inputSchema?: any; annotations?: Record<string, unknown> };
export type McpResource = { uri: string; name?: string; title?: string; description?: string; mimeType?: string };
export type McpTemplate = { uriTemplate: string; name?: string; description?: string; mimeType?: string };
export type McpPrompt = { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] };

export type McpInfo = {
  init: any;
  tools: McpTool[];
  resources: McpResource[];
  templates: McpTemplate[];
  prompts: McpPrompt[];
};

export type McpConnectConfig =
  | { transport: "http"; url: string; headers: [string, string][]; insecure: boolean; timeoutMs: number; network?: unknown }
  | { transport: "stdio"; command: string; args: string[]; env: [string, string][] };

export const mcpConnect = (id: string, config: McpConnectConfig) => invoke<any>("mcp_connect", { id, config });
export const mcpRequest = (id: string, method: string, params: unknown = {}) => invoke<any>("mcp_request", { id, method, params });
export const mcpClose = (id: string) => invoke("mcp_close", { id });

/** Split `-y @scope/pkg --flag "two words"` into arguments, honouring single and double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Follow `nextCursor` so servers with many tools still list completely (bounded). */
async function listAll<T>(id: string, method: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await mcpRequest(id, method, cursor ? { cursor } : {});
    out.push(...((r?.[key] as T[]) ?? []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** Load everything the server advertises. A list the server doesn't support is simply empty. */
export async function loadInfo(id: string, init: any): Promise<McpInfo> {
  const caps = init?.capabilities ?? {};
  const safe = async <T>(on: boolean, f: () => Promise<T[]>) => (on ? f().catch(() => [] as T[]) : []);
  const [tools, resources, templates, prompts] = await Promise.all([
    safe(!!caps.tools, () => listAll<McpTool>(id, "tools/list", "tools")),
    safe(!!caps.resources, () => listAll<McpResource>(id, "resources/list", "resources")),
    safe(!!caps.resources, () => listAll<McpTemplate>(id, "resources/templates/list", "resourceTemplates")),
    safe(!!caps.prompts, () => listAll<McpPrompt>(id, "prompts/list", "prompts")),
  ]);
  return { init, tools, resources, templates, prompts };
}

/** A label for a JSON-RPC message in the wire log: its method, or "result"/"error" for responses. */
export function rpcLabel(text: string): string {
  try {
    const m = JSON.parse(text);
    if (m.method) return String(m.method);
    if (m.error) return "error";
    if ("result" in m) return "result";
  } catch {
    /* not JSON */
  }
  return "message";
}
