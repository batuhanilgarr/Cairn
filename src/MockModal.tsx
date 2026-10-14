import { useCallback, useEffect, useState } from "react";
import { buildRoutes, type MockHit, type MockRoute } from "./lib/mock";
import { focusScope } from "./lib/focusScope";

type Props = {
  root: string;
  name: string;
  port: number | null;
  log: MockHit[];
  onStart: (port: number, includeEmpty: boolean) => Promise<void>;
  onStop: () => void;
  onClearLog: () => void;
  onClose: () => void;
};

const tone = (s: number) => (s >= 500 ? "s5" : s >= 400 ? "s4" : s >= 300 ? "s3" : "s2");

export function MockModal({ root, name, port, log, onStart, onStop, onClearLog, onClose }: Props) {
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [want, setWant] = useState(3001);
  const [routes, setRoutes] = useState<MockRoute[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const scan = useCallback(() => buildRoutes(root, includeEmpty).then(setRoutes).catch((e) => setError(String(e))), [root, includeEmpty]);
  useEffect(() => void scan(), [scan]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const url = port ? `http://127.0.0.1:${port}` : "";
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="mock" ref={focusScope} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Mock server">
        <div className="mock-head">
          <h3>Mock server <span className="muted">· {name}</span></h3>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted small">Serves your requests' saved examples locally, so a front-end or a teammate can work before the real API exists. Imported OpenAPI specs come with examples built from their schemas.</p>
        <div className="mock-bar">
          {port ? (
            <>
              <span className="conn ok">● Running</span>
              <code className="mock-url">{url}</code>
              <button className="btn small" onClick={() => { void navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied ✓" : "Copy URL"}</button>
              <div className="spacer" />
              <button className="btn small" onClick={() => void scan().then(() => onStart(port, includeEmpty))} title="Re-read the collection and restart">Reload routes</button>
              <button className="btn small stop" onClick={onStop}>Stop</button>
            </>
          ) : (
            <>
              <span className="conn idle">● Stopped</span>
              <label className="check small">Port <input className="cell narrow" type="number" value={want} min={1} max={65535} onChange={(e) => setWant(Number(e.target.value) || 3001)} /></label>
              <label className="check small"><input type="checkbox" checked={includeEmpty} onChange={(e) => setIncludeEmpty(e.target.checked)} /> Include requests without examples (answer 200 {"{}"})</label>
              <div className="spacer" />
              <button className="btn primary small" disabled={busy || !routes?.length} onClick={async () => { setBusy(true); setError(null); try { await onStart(want, includeEmpty); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Start</button>
            </>
          )}
        </div>
        {error && <p className="err small">{error}</p>}
        <div className="mock-cols">
          <div className="mock-routes">
            <h4>Routes {routes ? `(${routes.length})` : ""}</h4>
            {routes?.length === 0 && <p className="muted small">No request has saved examples yet. Import an OpenAPI spec, or send a request and use <b>Save as example</b>.</p>}
            {routes?.map((r, i) => (
              <div key={i} className="mock-route">
                <span className={`m m-${r.method.toUpperCase()}`}>{r.method.toUpperCase()}</span>
                <code>{r.path}</code>
                <span className="muted small">{r.examples.length ? r.examples.map((e) => e.status).join(" · ") : "200"}</span>
              </div>
            ))}
            <p className="muted small hint">Pick another example per call with the <code>X-Mock-Example: name</code> or <code>X-Mock-Status: 404</code> header (or <code>?__example=name</code>).</p>
          </div>
          <div className="mock-log">
            <div className="row"><h4>Requests</h4><div className="spacer" /><button className="link" onClick={onClearLog}>Clear</button></div>
            {log.length === 0 && <p className="muted small">{port ? "Waiting for requests…" : "Start the server to see requests here."}</p>}
            {[...log].reverse().map((h) => (
              <div key={h.n} className="mock-hit">
                <span className={`pill ${tone(h.status)}`}>{h.status}</span>
                <span className={`m m-${h.method}`}>{h.method}</span>
                <code>{h.path}</code>
                <span className="muted small">{h.example ?? ""} {h.ms} ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
