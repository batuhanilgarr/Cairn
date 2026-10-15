import { useEffect, useMemo, useRef, useState } from "react";
import { inspectSpec } from "./lib/openapi";
import { focusScope } from "./lib/focusScope";

/**
 * Import an OpenAPI/Swagger document that is on the clipboard (or a link to one). Paste with ⌘V into the box, or
 * use "Read clipboard"; the preview says what it is and how many requests it holds before anything is written.
 */
export function PasteImportModal({ onImport, onClose }: { onImport: (textOrUrl: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [shown, setShown] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // preview after a short pause, so typing in a big spec doesn't re-parse on every key
  useEffect(() => {
    const t = setTimeout(() => setShown(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  const info = useMemo(() => inspectSpec(shown), [shown]);

  const read = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) {
        setText(clip);
        setNote(null);
      } else setNote("The clipboard is empty.");
    } catch {
      setNote("Couldn't read the clipboard here: click in the box and press ⌘V.");
    }
  };
  // try once on open (works where the webview allows it); the box stays the fallback
  useEffect(() => void read(), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const ready = info.kind === "spec" || info.kind === "wsdl" || info.kind === "url" || (info.kind === "other" && /Too large/.test(info.reason));
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog paste" ref={(el) => { box.current = el; return focusScope(el); }} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Import OpenAPI from clipboard">
        <h3>Import OpenAPI from clipboard</h3>
        <p className="muted small">Paste an OpenAPI 3 or Swagger 2 document (JSON or YAML), a WSDL (SOAP), or a link to one.</p>
        <textarea
          ref={area}
          className="cell paste-box"
          aria-label="OpenAPI document or link"
          placeholder={"openapi: 3.0.3\ninfo:\n  title: …"}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="paste-status" role="status" aria-live="polite">
          {info.kind === "empty" && <span className="muted">Nothing pasted yet.</span>}
          {info.kind === "url" && <span>That's a link: Cairn will download the spec from <code>{info.url.length > 60 ? info.url.slice(0, 57) + "…" : info.url}</code> and import it.</span>}
          {info.kind === "other" && <span className={ready ? "muted" : "bad-text"}>{info.reason}</span>}
          {info.kind === "wsdl" && (
            <>
              <b>{info.title}</b> <span className="muted">· WSDL (SOAP) · {info.requests} {info.requests === 1 ? "request" : "requests"}{info.notes ? ` · ${info.notes} note${info.notes === 1 ? "" : "s"}` : ""}</span>
              <ul className="paste-list">
                {info.names.map((n) => <li key={n}><code>{n}</code></li>)}
                {info.requests > info.names.length && <li className="muted">…and {info.requests - info.names.length} more</li>}
              </ul>
            </>
          )}
          {info.kind === "spec" && (
            <>
              <b>{info.title}</b> <span className="muted">· {info.version} · {info.requests} {info.requests === 1 ? "request" : "requests"}{info.notes ? ` · ${info.notes} note${info.notes === 1 ? "" : "s"}` : ""}</span>
              <ul className="paste-list">
                {info.names.map((n) => <li key={n}><code>{n}</code></li>)}
                {info.requests > info.names.length && <li className="muted">…and {info.requests - info.names.length} more</li>}
              </ul>
            </>
          )}
        </div>
        {note && <p className="muted small" role="status">{note}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={() => void read()}>Read clipboard</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready} onClick={() => onImport(text.trim())}>Import</button>
        </div>
      </div>
    </div>
  );
}
