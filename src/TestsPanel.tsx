import type { AssertKind, AssertOp, Assertion, Capture, RequestTab } from "./lib/types";
import { uid } from "./lib/util";

const KINDS: { v: AssertKind; label: string }[] = [
  { v: "status", label: "Status code" },
  { v: "json", label: "JSON path" },
  { v: "header", label: "Header" },
  { v: "body", label: "Body text" },
  { v: "time", label: "Response time (ms)" },
];
const OPS: { v: AssertOp; label: string }[] = [
  { v: "eq", label: "equals" },
  { v: "neq", label: "not equals" },
  { v: "contains", label: "contains" },
  { v: "matches", label: "matches regex" },
  { v: "exists", label: "exists" },
  { v: "lt", label: "less than" },
  { v: "gt", label: "greater than" },
];

export function TestsPanel({ tab, patch }: { tab: RequestTab; patch: (p: Partial<RequestTab>) => void }) {
  const upA = (id: string, p: Partial<Assertion>) => patch({ assertions: tab.assertions.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  const upC = (id: string, p: Partial<Capture>) => patch({ captures: tab.captures.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  return (
    <div className="col wide">
      <h4>Assertions</h4>
      {tab.assertions.length === 0 && <p className="muted small">No code needed: check status, JSON fields, headers and timing after each send.</p>}
      {tab.assertions.map((a) => (
        <div className="kv-row" key={a.id}>
          <input type="checkbox" checked={a.enabled} onChange={(e) => upA(a.id, { enabled: e.target.checked })} aria-label="Enabled" />
          <select value={a.kind} onChange={(e) => upA(a.id, { kind: e.target.value as AssertKind })}>
            {KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
          </select>
          {(a.kind === "json" || a.kind === "header") && (
            <input className="cell" placeholder={a.kind === "json" ? "$.data.id" : "Content-Type"} value={a.path} spellCheck={false} onChange={(e) => upA(a.id, { path: e.target.value })} />
          )}
          <select value={a.op} onChange={(e) => upA(a.id, { op: e.target.value as AssertOp })}>
            {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          {a.op !== "exists" && <input className="cell" placeholder="value" value={a.value} spellCheck={false} onChange={(e) => upA(a.id, { value: e.target.value })} />}
          <button className="icon-btn" onClick={() => patch({ assertions: tab.assertions.filter((x) => x.id !== a.id) })} aria-label="Remove">×</button>
        </div>
      ))}
      <div>
        <button className="btn small" onClick={() => patch({ assertions: [...tab.assertions, { id: uid(), enabled: true, kind: "status", path: "", op: "eq", value: "200" }] })}>
          + Assertion
        </button>
      </div>

      <h4>Capture into variables</h4>
      {tab.captures.length === 0 && (
        <p className="muted small">Save a value from the response (a token, an id) as a variable for the requests that follow. Use it as <code>{"{{name}}"}</code>.</p>
      )}
      {tab.captures.map((c) => (
        <div className="kv-row" key={c.id}>
          <input className="cell" placeholder="variable" value={c.variable} spellCheck={false} onChange={(e) => upC(c.id, { variable: e.target.value })} />
          <span className="muted">←</span>
          <select value={c.from} onChange={(e) => upC(c.id, { from: e.target.value as "json" | "header" })}>
            <option value="json">JSON path</option>
            <option value="header">Header</option>
          </select>
          <input className="cell" placeholder={c.from === "json" ? "$.data.token" : "X-Request-Id"} value={c.path} spellCheck={false} onChange={(e) => upC(c.id, { path: e.target.value })} />
          <button className="icon-btn" onClick={() => patch({ captures: tab.captures.filter((x) => x.id !== c.id) })} aria-label="Remove">×</button>
        </div>
      ))}
      <div>
        <button className="btn small" onClick={() => patch({ captures: [...tab.captures, { id: uid(), variable: "", from: "json", path: "" }] })}>
          + Capture
        </button>
      </div>
    </div>
  );
}
