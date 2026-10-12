import { useState } from "react";
import { CodeEditor, type VarMap } from "./CodeEditor";
import { KVEditor } from "./KVEditor";
import type { RequestTab, ResponseExample } from "./lib/types";
import { emptyKV, uid } from "./lib/util";

const tone = (s: number) => (s >= 500 ? "s5" : s >= 400 ? "s4" : s >= 300 ? "s3" : "s2");

export function ExamplesPanel({ tab, patch, vars }: { tab: RequestTab; patch: (p: Partial<RequestTab>) => void; vars: VarMap }) {
  const [open, setOpen] = useState<string | null>(tab.examples[0]?.id ?? null);
  const up = (id: string, p: Partial<ResponseExample>) => patch({ examples: tab.examples.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const add = () => {
    const e: ResponseExample = { id: uid(), name: "New example", status: 200, headers: [{ ...emptyKV(), key: "Content-Type", value: "application/json" }, emptyKV()], body: "{\n  \n}", delayMs: 0 };
    patch({ examples: [...tab.examples, e] });
    setOpen(e.id);
  };
  return (
    <div className="col wide examples">
      <p className="muted small">
        Examples document what this request returns and are what the <b>mock server</b> answers with. Save a real response as an example with <b>Save as example</b> under the response, or add one by hand. In bodies, <code>{"{{params.id}}"}</code>, <code>{"{{query.page}}"}</code>, <code>{"{{$uuid}}"}</code>, <code>{"{{$timestamp}}"}</code> are filled in per request.
      </p>
      {tab.examples.map((e) => (
        <div key={e.id} className={`example ${open === e.id ? "open" : ""}`}>
          <div className="example-head" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <span className={`pill ${tone(e.status)}`}>{e.status}</span>
            <span className="example-name">{e.name}</span>
            <span className="muted small">{e.body ? `${e.body.length} chars` : "empty"}{e.delayMs ? ` · ${e.delayMs} ms delay` : ""}</span>
            <button className="icon-btn" aria-label="Delete example" onClick={(ev) => { ev.stopPropagation(); patch({ examples: tab.examples.filter((x) => x.id !== e.id) }); }}>×</button>
          </div>
          {open === e.id && (
            <div className="example-body">
              <div className="row">
                <input className="cell" placeholder="Name" value={e.name} onChange={(ev) => up(e.id, { name: ev.target.value })} />
                <label className="check">Status <input className="cell narrow" type="number" min={100} max={599} value={e.status} onChange={(ev) => up(e.id, { status: Number(ev.target.value) || 200 })} /></label>
                <label className="check">Delay (ms) <input className="cell narrow" type="number" min={0} value={e.delayMs} onChange={(ev) => up(e.id, { delayMs: Math.max(0, Number(ev.target.value) || 0) })} /></label>
              </div>
              <h4>Headers</h4>
              <KVEditor rows={e.headers} onChange={(headers) => up(e.id, { headers })} />
              <h4>Body</h4>
              <div className="example-editor">
                <CodeEditor className="boxed" lang={e.body.trim().startsWith("{") || e.body.trim().startsWith("[") ? "json" : "text"} value={e.body} vars={vars} onChange={(v) => up(e.id, { body: v })} />
              </div>
            </div>
          )}
        </div>
      ))}
      <div><button className="btn small" onClick={add}>+ Example</button></div>
    </div>
  );
}
