import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { MergeView } from "@codemirror/merge";
import { highlight, theme } from "./CodeEditor";
import type { ResponseData } from "./lib/types";
import { tryPrettyJson } from "./lib/util";
import { focusScope } from "./lib/focusScope";

export type HistEntry = { n: number; at: number; response: ResponseData };

const when = (t: number) => new Date(t).toTimeString().slice(0, 8);
const label = (h: HistEntry) => `${when(h.at)} · ${h.response.status} · ${h.response.timeMs} ms · ${h.response.sizeBytes} B`;
const bodyOf = (r: ResponseData) => (r.bodyBase64 ? `(binary, ${r.sizeBytes} bytes)` : r.bodyId != null ? `(large response, ${r.sizeBytes} bytes, not compared)` : (tryPrettyJson(r.body) ?? r.body));
const headersOf = (r: ResponseData) => r.headers.map(([k, v]) => `${k}: ${v}`).sort().join("\n");

/** Side-by-side diff of two responses of the same request: body or headers, unchanged regions folded. */
export function DiffModal({ items, onClose }: { items: HistEntry[]; onClose: () => void }) {
  const [a, setA] = useState(items.length > 1 ? items.length - 2 : 0);
  const [b, setB] = useState(items.length - 1);
  const [what, setWhat] = useState<"body" | "headers">("body");
  const host = useRef<HTMLDivElement>(null);

  const docs = useMemo(() => {
    const f = what === "body" ? bodyOf : headersOf;
    return [f(items[a].response), f(items[b].response)] as const;
  }, [items, a, b, what]);

  useEffect(() => {
    if (!host.current) return;
    const ext = [theme, syntaxHighlighting(highlight), EditorView.editable.of(false), EditorState.readOnly.of(true), EditorView.lineWrapping, ...(what === "body" ? [json()] : [])];
    const mv = new MergeView({
      parent: host.current,
      a: { doc: docs[0], extensions: [...ext, EditorView.contentAttributes.of({ "aria-label": "First response" })] },
      b: { doc: docs[1], extensions: [...ext, EditorView.contentAttributes.of({ "aria-label": "Second response" })] },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return () => mv.destroy();
  }, [docs, what]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const same = docs[0] === docs[1];
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="diff" ref={focusScope} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Compare responses">
        <div className="diff-head">
          <h3>Compare responses</h3>
          <div className="seg">
            <button className={what === "body" ? "on" : ""} onClick={() => setWhat("body")}>Body</button>
            <button className={what === "headers" ? "on" : ""} onClick={() => setWhat("headers")}>Headers</button>
          </div>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="diff-pick">
          <select aria-label="First response" value={a} onChange={(e) => setA(Number(e.target.value))}>
            {items.map((h, i) => <option key={h.n} value={i}>{label(h)}</option>)}
          </select>
          <span className="muted">→</span>
          <select aria-label="Second response" value={b} onChange={(e) => setB(Number(e.target.value))}>
            {items.map((h, i) => <option key={h.n} value={i}>{label(h)}</option>)}
          </select>
          {same && <span className="ok-text small">Identical</span>}
        </div>
        <div className="diff-body" ref={host} />
      </div>
    </div>
  );
}
