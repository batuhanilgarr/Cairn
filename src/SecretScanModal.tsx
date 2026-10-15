import { useEffect, useRef } from "react";
import { byFile, type Finding } from "./lib/secrets";
import { focusScope } from "./lib/focusScope";

export type ScanState = { root: string; scanning: boolean; findings: Finding[]; fixing: boolean; note?: string };

const rel = (root: string, file: string) => (file.startsWith(root + "/") ? file.slice(root.length + 1) : file);

/** Lists credentials that sit in committed files and moves them into secret variables. Values are shown masked, never in full. */
export function SecretScanModal({ state, envName, onFix, onFixAll, onRescan, onClose }: { state: ScanState; envName: string; onFix: (f: Finding) => void; onFixAll: () => void; onRescan: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  // a fixed row (and the button you pressed) disappears: keep keyboard focus inside the dialog
  useEffect(() => {
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
  });
  const fixable = state.findings.filter((f) => f.fixable);
  const groups = byFile(state.findings);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog scan" ref={(el) => { box.current = el; return focusScope(el); }} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Scan for secrets">
        <h3>Scan for secrets</h3>
        <p className="muted small">Looks for tokens, passwords and keys written into files that you commit. Only a masked preview is shown.</p>
        {state.scanning ? (
          <p role="status">Scanning…</p>
        ) : state.findings.length === 0 ? (
          <p className="scan-ok" role="status">No secrets found in this collection’s files.</p>
        ) : (
          <>
            <p className="scan-sum" role="status">
              <b>{state.findings.length}</b> {state.findings.length === 1 ? "finding" : "findings"} in {groups.length} {groups.length === 1 ? "file" : "files"}
            </p>
            <div className="scan-list">
              {groups.map(([file, list]) => (
                <section key={file} aria-label={rel(state.root, file)}>
                  <h4>{rel(state.root, file)}</h4>
                  {list.map((f, i) => (
                    <div key={i} className="scan-row">
                      <span className={`sev ${f.severity}`}>{f.severity}</span>
                      <div className="scan-main">
                        <div className="scan-kind">{f.kind}</div>
                        <div className="muted small">{f.line ? `line ${f.line} · ` : ""}<code>{f.preview}</code></div>
                      </div>
                      {f.fixable && <button className="btn small" disabled={state.fixing} onClick={() => onFix(f)}>{/\.env\.ya?ml$/.test(f.file) ? "Mark as secret" : "Move to secret"}</button>}
                    </div>
                  ))}
                </section>
              ))}
            </div>
            {fixable.length > 0 && <p className="muted small">“Move to secret” replaces the value with a variable reference and keeps the value in <b>{envName}</b> as a secret variable, which stays on this Mac and out of Git.</p>}
            <p className="muted small">If a value was already committed, rotate it: removing it from the file doesn’t remove it from Git history.</p>
          </>
        )}
        {state.note && <p className="muted small" role="status">{state.note}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={onRescan} disabled={state.scanning || state.fixing}>Scan again</button>
          {fixable.length > 1 && <button className="btn" onClick={onFixAll} disabled={state.fixing}>Fix all ({fixable.length})</button>}
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
