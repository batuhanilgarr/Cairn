import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KVEditor } from "./KVEditor";
import type { AuthMode, BodyMode, Environment, HistoryItem, RequestTab, ResponseData } from "./lib/types";
import {
  METHODS,
  buildRequest,
  emptyKV,
  formatBytes,
  highlightJson,
  load,
  newTab,
  save,
  statusClass,
  tryPrettyJson,
  uid,
} from "./lib/util";
import "./styles.css";

type ReqSection = "params" | "headers" | "body" | "auth" | "settings";
type ResSection = "body" | "headers";
type SideSection = "history" | "environments";

const defaultEnvs: Environment[] = [
  { id: "env-local", name: "Local", vars: [emptyKV()] },
];

export default function App() {
  const [tabs, setTabs] = useState<RequestTab[]>(() => {
    const t = load<RequestTab[]>("rq.tabs", []);
    return t.length ? t : [newTab()];
  });
  const [activeId, setActiveId] = useState<string>(() => load("rq.active", "") || "");
  const [envs, setEnvs] = useState<Environment[]>(() => load("rq.envs", defaultEnvs));
  const [envId, setEnvId] = useState<string>(() => load("rq.envId", "env-local"));
  const [history, setHistory] = useState<HistoryItem[]>(() => load("rq.history", []));
  const [responses, setResponses] = useState<Record<string, ResponseData | { error: string } | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [reqSection, setReqSection] = useState<ReqSection>("params");
  const [resSection, setResSection] = useState<ResSection>("body");
  const [side, setSide] = useState<SideSection>("history");
  const [rawView, setRawView] = useState(false);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const env = envs.find((e) => e.id === envId);
  const response = active ? responses[active.id] : null;

  useEffect(() => save("rq.tabs", tabs), [tabs]);
  useEffect(() => save("rq.active", active?.id ?? ""), [active?.id]);
  useEffect(() => save("rq.envs", envs), [envs]);
  useEffect(() => save("rq.envId", envId), [envId]);
  useEffect(() => save("rq.history", history.slice(0, 100)), [history]);

  const patch = useCallback(
    (p: Partial<RequestTab>) => setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, ...p } : t))),
    [active?.id],
  );

  const addTab = (t?: RequestTab) => {
    const tab = t ?? newTab();
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (!next.length) {
        const fresh = newTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === active.id) setActiveId(next[Math.max(0, ts.findIndex((t) => t.id === id) - 1)].id);
      return next;
    });
  };

  const send = useCallback(async () => {
    if (!active || !active.url.trim()) return;
    const tab = active;
    setLoading((l) => ({ ...l, [tab.id]: true }));
    setResponses((r) => ({ ...r, [tab.id]: null }));
    let status: number | null = null;
    try {
      const res = await invoke<ResponseData>("send_request", { spec: buildRequest(tab, env) });
      status = res.status;
      setResponses((r) => ({ ...r, [tab.id]: res }));
    } catch (e) {
      setResponses((r) => ({ ...r, [tab.id]: { error: String(e) } }));
    } finally {
      setLoading((l) => ({ ...l, [tab.id]: false }));
      setHistory((h) =>
        [{ id: uid(), at: Date.now(), method: tab.method, url: tab.url, status, tab }, ...h].slice(0, 100),
      );
    }
  }, [active, env]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        addTab();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeTab(active.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tabTitle = (t: RequestTab) => t.name !== "New request" ? t.name : t.url.replace(/^https?:\/\//, "") || "New request";

  const counts = useMemo(
    () => ({
      params: active?.params.filter((p) => p.enabled && p.key).length ?? 0,
      headers: active?.headers.filter((p) => p.enabled && p.key).length ?? 0,
    }),
    [active],
  );

  const resBody = useMemo(() => {
    if (!response || "error" in response) return null;
    const pretty = tryPrettyJson(response.body);
    return { pretty, text: response.body };
  }, [response]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="titlebar-drag" data-tauri-drag-region />
        <div className="brand">
          <span className="logo">◆</span> Reqnest
        </div>
        <div className="seg">
          <button className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>
            History
          </button>
          <button className={side === "environments" ? "on" : ""} onClick={() => setSide("environments")}>
            Environments
          </button>
        </div>
        <div className="side-body">
          {side === "history" && (
            <>
              {history.length === 0 && <p className="muted pad">Sent requests will show up here.</p>}
              {history.map((h) => (
                <button key={h.id} className="hist" onClick={() => addTab({ ...h.tab, id: uid() })}>
                  <span className={`m m-${h.method}`}>{h.method}</span>
                  <span className="hist-url">{h.url.replace(/^https?:\/\//, "")}</span>
                  {h.status !== null && <span className={`dot ${statusClass(h.status)}`}>{h.status}</span>}
                </button>
              ))}
              {history.length > 0 && (
                <button className="link pad" onClick={() => setHistory([])}>
                  Clear history
                </button>
              )}
            </>
          )}
          {side === "environments" && (
            <div className="pad">
              <div className="row">
                <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn small"
                  onClick={() => {
                    const e: Environment = { id: uid(), name: `Env ${envs.length + 1}`, vars: [emptyKV()] };
                    setEnvs([...envs, e]);
                    setEnvId(e.id);
                  }}
                >
                  + New
                </button>
              </div>
              {env && (
                <>
                  <input
                    className="cell name"
                    value={env.name}
                    onChange={(e) => setEnvs(envs.map((x) => (x.id === env.id ? { ...x, name: e.target.value } : x)))}
                  />
                  <p className="muted">
                    Use variables as <code>{"{{name}}"}</code> in URL, headers, body and auth.
                  </p>
                  <KVEditor
                    rows={env.vars}
                    keyPlaceholder="Variable"
                    onChange={(vars) => setEnvs(envs.map((x) => (x.id === env.id ? { ...x, vars } : x)))}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="tabbar" data-tauri-drag-region>
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active.id ? "on" : ""}`} onClick={() => setActiveId(t.id)}>
              <span className={`m m-${t.method}`}>{t.method}</span>
              <span className="tab-title">{tabTitle(t)}</span>
              <button
                className="icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          ))}
          <button className="icon-btn plus" onClick={() => addTab()} aria-label="New tab">
            +
          </button>
          <div className="spacer" />
          <select className="env-pick" value={envId} onChange={(e) => setEnvId(e.target.value)} title="Environment">
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        <div className="urlbar">
          <select className={`method m-${active.method}`} value={active.method} onChange={(e) => patch({ method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="url"
            placeholder="Enter URL, e.g. https://api.example.com/users  (use {{vars}})"
            value={active.url}
            spellCheck={false}
            onChange={(e) => patch({ url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="btn primary" onClick={send} disabled={loading[active.id]}>
            {loading[active.id] ? "Sending…" : "Send"}
            <kbd>⌘↵</kbd>
          </button>
        </div>

        <section className="panel req">
          <nav className="subtabs">
            {(["params", "headers", "body", "auth", "settings"] as ReqSection[]).map((s) => (
              <button key={s} className={reqSection === s ? "on" : ""} onClick={() => setReqSection(s)}>
                {s[0].toUpperCase() + s.slice(1)}
                {s === "params" && counts.params > 0 && <i>{counts.params}</i>}
                {s === "headers" && counts.headers > 0 && <i>{counts.headers}</i>}
              </button>
            ))}
          </nav>
          <div className="panel-body">
            {reqSection === "params" && <KVEditor rows={active.params} onChange={(params) => patch({ params })} />}
            {reqSection === "headers" && <KVEditor rows={active.headers} onChange={(headers) => patch({ headers })} />}
            {reqSection === "body" && (
              <div className="col">
                <div className="row">
                  {(["none", "json", "text", "form"] as BodyMode[]).map((m) => (
                    <label key={m} className="radio">
                      <input type="radio" checked={active.bodyMode === m} onChange={() => patch({ bodyMode: m })} />
                      {m === "form" ? "form-urlencoded" : m}
                    </label>
                  ))}
                  {active.bodyMode === "json" && (
                    <button
                      className="btn small"
                      onClick={() => {
                        const p = tryPrettyJson(active.body);
                        if (p) patch({ body: p });
                      }}
                    >
                      Prettify
                    </button>
                  )}
                </div>
                {active.bodyMode === "none" ? (
                  <p className="muted">This request has no body.</p>
                ) : (
                  <textarea
                    className="editor"
                    spellCheck={false}
                    value={active.body}
                    placeholder={active.bodyMode === "form" ? "key=value&other=value" : active.bodyMode === "json" ? '{ "hello": "world" }' : ""}
                    onChange={(e) => patch({ body: e.target.value })}
                  />
                )}
              </div>
            )}
            {reqSection === "auth" && (
              <div className="col">
                <select value={active.authMode} onChange={(e) => patch({ authMode: e.target.value as AuthMode })}>
                  <option value="none">No auth</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Basic auth</option>
                </select>
                {active.authMode === "bearer" && (
                  <input className="cell" placeholder="Token" value={active.authToken} onChange={(e) => patch({ authToken: e.target.value })} />
                )}
                {active.authMode === "basic" && (
                  <>
                    <input className="cell" placeholder="Username" value={active.authUser} onChange={(e) => patch({ authUser: e.target.value })} />
                    <input className="cell" type="password" placeholder="Password" value={active.authPass} onChange={(e) => patch({ authPass: e.target.value })} />
                  </>
                )}
              </div>
            )}
            {reqSection === "settings" && (
              <div className="col">
                <label className="check">
                  <input type="checkbox" checked={active.followRedirects} onChange={(e) => patch({ followRedirects: e.target.checked })} />
                  Follow redirects
                </label>
                <label className="check">
                  <input type="checkbox" checked={active.insecure} onChange={(e) => patch({ insecure: e.target.checked })} />
                  Skip TLS certificate verification (self-signed)
                </label>
                <label className="check">
                  Timeout (ms)
                  <input
                    className="cell narrow"
                    type="number"
                    value={active.timeoutMs}
                    onChange={(e) => patch({ timeoutMs: Number(e.target.value) || 30000 })}
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="panel res">
          <nav className="subtabs">
            <button className={resSection === "body" ? "on" : ""} onClick={() => setResSection("body")}>
              Response
            </button>
            <button className={resSection === "headers" ? "on" : ""} onClick={() => setResSection("headers")}>
              Headers{response && !("error" in response) && <i>{response.headers.length}</i>}
            </button>
            <div className="spacer" />
            {response && !("error" in response) && (
              <div className="meta">
                <span className={`pill ${statusClass(response.status)}`}>
                  {response.status} {response.statusText}
                </span>
                <span>{response.timeMs} ms</span>
                <span>{formatBytes(response.sizeBytes)}</span>
                <span>{response.httpVersion}</span>
              </div>
            )}
          </nav>
          <div className="panel-body">
            {loading[active.id] && <p className="muted">Sending request…</p>}
            {!loading[active.id] && !response && <p className="muted center">Hit <kbd>⌘↵</kbd> to send a request.</p>}
            {response && "error" in response && <pre className="err">{response.error}</pre>}
            {response && !("error" in response) && resSection === "body" && resBody && (
              <>
                <div className="row tools">
                  {resBody.pretty && (
                    <label className="check">
                      <input type="checkbox" checked={rawView} onChange={(e) => setRawView(e.target.checked)} /> Raw
                    </label>
                  )}
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(resBody.pretty ?? resBody.text)}>
                    Copy
                  </button>
                </div>
                {resBody.pretty && !rawView ? (
                  <pre className="code" dangerouslySetInnerHTML={{ __html: highlightJson(resBody.pretty) }} />
                ) : (
                  <pre className="code">{resBody.text}</pre>
                )}
              </>
            )}
            {response && !("error" in response) && resSection === "headers" && (
              <table className="htable">
                <tbody>
                  {response.headers.map(([k, v], i) => (
                    <tr key={i}>
                      <td>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
