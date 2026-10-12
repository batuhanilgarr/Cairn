import { useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { MAX_ENTRIES, type StreamEntry, type StreamState } from "./lib/stream";

const STATUS: Record<StreamState["status"], { label: string; cls: string }> = {
  idle: { label: "Not connected", cls: "idle" },
  connecting: { label: "Connecting…", cls: "wait" },
  open: { label: "Connected", cls: "ok" },
  closed: { label: "Disconnected", cls: "idle" },
  error: { label: "Error", cls: "bad" },
};

const time = (t: number) => {
  const d = new Date(t);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

const pretty = (text: string) => {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
};

export function StreamLog({ state, onClear, emptyHint }: { state: StreamState; onClear: () => void; emptyHint: string }) {
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const st = STATUS[state.status];

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? state.entries.filter((e) => e.text.toLowerCase().includes(f) || e.label.toLowerCase().includes(f)) : state.entries;
  }, [state.entries, filter]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [rows.length, follow]);

  const toggle = (n: number) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });

  const copyAll = () =>
    navigator.clipboard.writeText(rows.map((e) => `${time(e.at)} ${e.dir === "out" ? "→" : e.dir === "in" ? "←" : "•"} [${e.label}] ${e.text}`).join("\n"));

  return (
    <section className="panel res stream">
      <nav className="subtabs">
        <span className={`conn ${st.cls}`}>● {st.label}</span>
        {state.info && <span className="muted small">{state.info}</span>}
        <div className="spacer" />
        <span className="muted small">↑ {state.sent} · ↓ {state.received}</span>
        <input className="cell filter" placeholder="Filter" value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
        <label className="check small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button className="btn small" onClick={copyAll} disabled={!rows.length}>Copy</button>
        <button className="btn small" onClick={() => { onClear(); setOpen(new Set()); }} disabled={!state.entries.length}>Clear</button>
      </nav>
      <div className="log" ref={box}>
        {state.dropped > 0 && <p className="muted small pad">The oldest {state.dropped} messages were dropped (keeping the last {MAX_ENTRIES}).</p>}
        {rows.length === 0 && <p className="muted center">{state.entries.length ? "No messages match the filter." : emptyHint}</p>}
        {rows.map((e) => (
          <Row key={e.n} e={e} open={open.has(e.n)} onToggle={() => toggle(e.n)} />
        ))}
      </div>
    </section>
  );
}

function Row({ e, open, onToggle }: { e: StreamEntry; open: boolean; onToggle: () => void }) {
  const one = e.text.replace(/\s+/g, " ").slice(0, 200);
  const body = open ? pretty(e.text) : null;
  return (
    <div className={`log-row ${e.dir} ${e.tone ?? ""}`}>
      <div className="log-line" onClick={onToggle}>
        <span className="log-dir">{e.dir === "out" ? "↑" : e.dir === "in" ? "↓" : "•"}</span>
        <span className="log-time">{time(e.at)}</span>
        <span className="log-label">{e.label}</span>
        <span className="log-text">{one}</span>
        {e.size !== undefined && <span className="log-size">{e.size} B</span>}
      </div>
      {body && (
        <div className="log-detail">
          <CodeEditor readOnly wrap lang={body.json ? "json" : "text"} value={body.text} />
        </div>
      )}
    </div>
  );
}
