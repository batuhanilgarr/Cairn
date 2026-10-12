import { useEffect, useMemo, useState } from "react";
import { CodeEditor, type VarMap } from "./CodeEditor";
import { KVEditor } from "./KVEditor";
import { sampleFromSchema } from "./lib/openapi";
import type { McpInfo, McpPrompt, McpResource, McpTool } from "./lib/mcp";
import type { RequestTab } from "./lib/types";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  connected: boolean;
  connecting: boolean;
  info: McpInfo | undefined;
  call: (method: string, params: unknown) => Promise<any>;
};

type View = "tools" | "resources" | "prompts" | "raw";
type Outcome = { ok: boolean; value: any; ms: number } | null;

const METHODS = ["tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel", "ping"];

const sampleArgs = (schema: any) => {
  try {
    return JSON.stringify(sampleFromSchema({}, schema ?? { type: "object" }) ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

export function McpPanel({ tab, patch, vars, connected, connecting, info, call }: Props) {
  const [view, setView] = useState<View>("tools");
  const m = tab.mcp;
  const setM = (p: Partial<typeof m>) => patch({ mcp: { ...m, ...p } });

  return (
    <div className="mcp">
      <div className="mcp-top">
        <div className="seg">
          <button className={m.transport === "http" ? "on" : ""} onClick={() => setM({ transport: "http" })} disabled={connected}>HTTP</button>
          <button className={m.transport === "stdio" ? "on" : ""} onClick={() => setM({ transport: "stdio" })} disabled={connected}>stdio (local command)</button>
        </div>
        {connected && info && (
          <span className="muted small">
            <b>{info.init?.serverInfo?.name ?? "server"}</b> {info.init?.serverInfo?.version ?? ""} · protocol {info.init?.protocolVersion}
            {" · "}{info.tools.length} tools · {info.resources.length} resources · {info.prompts.length} prompts
          </span>
        )}
      </div>

      {m.transport === "stdio" && !connected && (
        <div className="mcp-stdio">
          <label className="field"><span>Command</span><input className="cell" placeholder="npx" spellCheck={false} value={m.command} onChange={(e) => setM({ command: e.target.value })} /></label>
          <label className="field"><span>Arguments</span><input className="cell" placeholder="-y @modelcontextprotocol/server-everything" spellCheck={false} value={m.args} onChange={(e) => setM({ args: e.target.value })} /></label>
          <div><span className="muted small">Environment variables</span><KVEditor rows={m.env} keyPlaceholder="NAME" onChange={(env) => setM({ env })} /></div>
          <p className="muted small">Starts the server as a child process and talks to it over stdin/stdout. Your login shell's PATH is used, so <code>npx</code>, <code>uvx</code> and Homebrew tools are found.</p>
        </div>
      )}
      {m.transport === "http" && !connected && (
        <p className="muted small">Enter the server's MCP endpoint in the address bar (Streamable HTTP, e.g. <code>https://example.com/mcp</code>). Credentials go in the Auth or Headers tab.</p>
      )}

      {!connected && !connecting && <p className="muted">Connect to explore the server's tools, resources and prompts.</p>}
      {connecting && <p className="muted">Connecting…</p>}

      {connected && info && (
        <>
          <nav className="subtabs mcp-nav">
            {(["tools", "resources", "prompts", "raw"] as View[]).map((v) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {v === "raw" ? "Raw JSON-RPC" : v[0].toUpperCase() + v.slice(1)}
                {v !== "raw" && <i>{info[v === "tools" ? "tools" : v === "resources" ? "resources" : "prompts"].length}</i>}
              </button>
            ))}
          </nav>
          <div className="mcp-body">
            {view === "tools" && <Tools tools={info.tools} vars={vars} call={call} />}
            {view === "resources" && <Resources items={info.resources} templates={info.templates} call={call} />}
            {view === "prompts" && <Prompts items={info.prompts} vars={vars} call={call} />}
            {view === "raw" && <Raw vars={vars} call={call} />}
          </div>
          {info.init?.instructions && (
            <details className="mcp-instr"><summary>Server instructions</summary><pre className="code">{info.init.instructions}</pre></details>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------ shared bits ------------------------------ */

function useCall(call: Props["call"]) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (method: string, params: unknown) => {
    if (method === "__invalid__") {
      // a client-side validation message (e.g. bad JSON), shown like any other error
      setOut(null);
      return setErr(String(params));
    }
    setBusy(true);
    setErr(null);
    const t = performance.now();
    try {
      const value = await call(method, params);
      setOut({ ok: true, value, ms: Math.round(performance.now() - t) });
    } catch (e) {
      setOut(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, out, err, run, reset: () => { setOut(null); setErr(null); } };
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: text.trim() ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
};

function Json({ value }: { value: unknown }) {
  return <div className="mcp-json"><CodeEditor readOnly wrap lang="json" className="boxed" value={JSON.stringify(value, null, 2)} /></div>;
}

/** MCP content blocks: text, image, audio, embedded resources. */
function Blocks({ content }: { content: any[] }) {
  return (
    <div className="blocks">
      {content.map((b, i) => {
        if (b.type === "text") {
          let pretty = b.text as string;
          try { pretty = JSON.stringify(JSON.parse(b.text), null, 2); } catch { /* plain text */ }
          return <pre key={i} className="code block">{pretty}</pre>;
        }
        if (b.type === "image") return <div key={i} className="bin-media"><img src={`data:${b.mimeType};base64,${b.data}`} alt="Tool result" /></div>;
        if (b.type === "audio") return <audio key={i} controls src={`data:${b.mimeType};base64,${b.data}`} />;
        if (b.type === "resource" || b.type === "resource_link") {
          const r = b.resource ?? b;
          return <div key={i} className="block"><code>{r.uri}</code>{r.mimeType && <span className="muted small"> · {r.mimeType}</span>}{r.text && <pre className="code">{r.text}</pre>}{r.blob && <p className="muted small">binary, {r.blob.length} base64 chars</p>}</div>;
        }
        return <pre key={i} className="code block">{JSON.stringify(b, null, 2)}</pre>;
      })}
    </div>
  );
}

/* --------------------------------- tools --------------------------------- */

function Tools({ tools, vars, call }: { tools: McpTool[]; vars: VarMap; call: Props["call"] }) {
  const [sel, setSel] = useState<string | null>(tools[0]?.name ?? null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [raw, setRaw] = useState(false);
  const { busy, out, err, run, reset } = useCall(call);
  const tool = tools.find((t) => t.name === sel);
  useEffect(() => reset(), [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = tool ? (args[tool.name] ?? sampleArgs(tool.inputSchema)) : "";
  const list = useMemo(() => tools.filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [tools, q]);
  const props = tool?.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [];

  if (!tools.length) return <p className="muted">This server offers no tools.</p>;
  return (
    <div className="mcp-split">
      <div className="mcp-list">
        <input className="cell" placeholder="Filter tools" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.map((t) => (
          <button key={t.name} className={sel === t.name ? "on" : ""} onClick={() => setSel(t.name)}>
            <b>{t.title ?? t.name}</b>
            {t.description && <small>{t.description.split("\n")[0]}</small>}
          </button>
        ))}
      </div>
      {tool && (
        <div className="mcp-detail">
          <h4>{tool.name}</h4>
          {tool.description && <p className="muted small pre">{tool.description}</p>}
          {props.length > 0 && (
            <p className="muted small">
              Arguments: {props.map((p) => <code key={p}>{p}{(tool.inputSchema.required ?? []).includes(p) ? "*" : ""}</code>)}
            </p>
          )}
          <div className="mcp-args">
            <CodeEditor className="boxed" lang="json" vars={vars} value={text} onChange={(v) => setArgs((a) => ({ ...a, [tool.name]: v }))} />
          </div>
          <div className="row">
            <button className="btn primary small" disabled={busy} onClick={() => {
              const p = parseJson(text);
              if (!p.ok) return void run("__invalid__", p.error);
              void run("tools/call", { name: tool.name, arguments: p.value });
            }}>{busy ? "Calling…" : "Call tool"}</button>
            <button className="btn small" onClick={() => setArgs((a) => ({ ...a, [tool.name]: sampleArgs(tool.inputSchema) }))}>Reset arguments</button>
            <div className="spacer" />
            {out && <label className="check small"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw result</label>}
          </div>
          {err && <p className="err small">{err.startsWith("Not valid JSON") ? err : err}</p>}
          {out && (
            <div className="mcp-result">
              <p className={`small ${out.value?.isError ? "err" : "ok-text"}`}>{out.value?.isError ? "Tool reported an error" : "Success"} · {out.ms} ms</p>
              {raw || !Array.isArray(out.value?.content) ? <Json value={out.value} /> : (
                <>
                  <Blocks content={out.value.content} />
                  {out.value.structuredContent && <><h4>Structured content</h4><Json value={out.value.structuredContent} /></>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- resources ------------------------------- */

function Resources({ items, templates, call }: { items: McpResource[]; templates: any[]; call: Props["call"] }) {
  const [uri, setUri] = useState(items[0]?.uri ?? "");
  const { busy, out, err, run } = useCall(call);
  if (!items.length && !templates.length) return <p className="muted">This server offers no resources.</p>;
  return (
    <div className="mcp-split">
      <div className="mcp-list">
        {items.map((r) => (
          <button key={r.uri} className={uri === r.uri ? "on" : ""} onClick={() => { setUri(r.uri); void run("resources/read", { uri: r.uri }); }}>
            <b>{r.title ?? r.name ?? r.uri}</b>
            <small>{r.uri}{r.mimeType ? ` · ${r.mimeType}` : ""}</small>
          </button>
        ))}
        {templates.length > 0 && <h4>Templates</h4>}
        {templates.map((t: any) => (
          <button key={t.uriTemplate} onClick={() => setUri(t.uriTemplate)} title="Fill in the placeholders, then Read">
            <b>{t.name ?? t.uriTemplate}</b><small>{t.uriTemplate}</small>
          </button>
        ))}
      </div>
      <div className="mcp-detail">
        <div className="row">
          <input className="cell" placeholder="resource URI" value={uri} spellCheck={false} onChange={(e) => setUri(e.target.value)} />
          <button className="btn primary small" disabled={busy || !uri} onClick={() => void run("resources/read", { uri })}>{busy ? "Reading…" : "Read"}</button>
        </div>
        {err && <p className="err small">{err}</p>}
        {out && (out.value?.contents ?? []).map((c: any, i: number) => (
          <div key={i} className="block">
            <p className="muted small"><code>{c.uri}</code>{c.mimeType ? ` · ${c.mimeType}` : ""}</p>
            {c.text !== undefined ? <pre className="code block">{(() => { try { return JSON.stringify(JSON.parse(c.text), null, 2); } catch { return c.text; } })()}</pre> : <p className="muted small">binary content ({c.blob?.length ?? 0} base64 chars)</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- prompts -------------------------------- */

function Prompts({ items, vars, call }: { items: McpPrompt[]; vars: VarMap; call: Props["call"] }) {
  const [sel, setSel] = useState<string | null>(items[0]?.name ?? null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const { busy, out, err, run, reset } = useCall(call);
  const p = items.find((x) => x.name === sel);
  useEffect(() => reset(), [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return <p className="muted">This server offers no prompts.</p>;
  const template = (pr: McpPrompt) => JSON.stringify(Object.fromEntries((pr.arguments ?? []).map((a) => [a.name, ""])), null, 2);
  const text = p ? (args[p.name] ?? template(p)) : "";
  return (
    <div className="mcp-split">
      <div className="mcp-list">
        {items.map((x) => (
          <button key={x.name} className={sel === x.name ? "on" : ""} onClick={() => setSel(x.name)}>
            <b>{x.title ?? x.name}</b>{x.description && <small>{x.description.split("\n")[0]}</small>}
          </button>
        ))}
      </div>
      {p && (
        <div className="mcp-detail">
          <h4>{p.name}</h4>
          {p.description && <p className="muted small">{p.description}</p>}
          {(p.arguments ?? []).length > 0 && <p className="muted small">Arguments: {(p.arguments ?? []).map((a) => <code key={a.name} title={a.description}>{a.name}{a.required ? "*" : ""}</code>)}</p>}
          <div className="mcp-args"><CodeEditor className="boxed" lang="json" vars={vars} value={text} onChange={(v) => setArgs((a) => ({ ...a, [p.name]: v }))} /></div>
          <div className="row">
            <button className="btn primary small" disabled={busy} onClick={() => { const j = parseJson(text); if (j.ok) void run("prompts/get", { name: p.name, arguments: j.value }); else void run("__invalid__", j.error); }}>{busy ? "Getting…" : "Get prompt"}</button>
          </div>
          {err && <p className="err small">{err}</p>}
          {out && (out.value?.messages ?? []).map((msg: any, i: number) => (
            <div key={i} className="block"><p className="muted small">{msg.role}</p><Blocks content={[msg.content]} /></div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------- raw ----------------------------------- */

function Raw({ vars, call }: { vars: VarMap; call: Props["call"] }) {
  const [method, setMethod] = useState("tools/list");
  const [params, setParams] = useState("{}");
  const { busy, out, err, run } = useCall(call);
  return (
    <div className="mcp-raw">
      <div className="row">
        <input className="cell" list="mcp-methods" value={method} spellCheck={false} onChange={(e) => setMethod(e.target.value)} placeholder="method" />
        <datalist id="mcp-methods">{METHODS.map((x) => <option key={x} value={x} />)}</datalist>
        <button className="btn primary small" disabled={busy || !method.trim()} onClick={() => { const j = parseJson(params); if (j.ok) void run(method.trim(), j.value); else void run("__invalid__", j.error); }}>{busy ? "Sending…" : "Send request"}</button>
      </div>
      <div className="mcp-args"><CodeEditor className="boxed" lang="json" vars={vars} value={params} onChange={setParams} /></div>
      {err && <p className="err small">{err}</p>}
      {out && <Json value={out.value} />}
    </div>
  );
}
