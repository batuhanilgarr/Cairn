import { useState } from "react";
import type { RequestTab } from "./lib/types";
import { KVEditor } from "./KVEditor";
import { AuthPanel } from "./AuthPanel";
import { ScriptsPanel } from "./ScriptsPanel";

type Section = "headers" | "auth" | "scripts";

/** Edits a folder's (or the collection's) defaults: headers, auth and scripts every request below it inherits. */
export function DefaultsModal({ title, initial, onSave, onClose }: { title: string; initial: RequestTab; onSave: (t: RequestTab) => void; onClose: () => void }) {
  const [tab, setTab] = useState<RequestTab>(initial);
  const [section, setSection] = useState<Section>("headers");
  const patch = (p: Partial<RequestTab>) => setTab((t) => ({ ...t, ...p }));
  const count = tab.headers.filter((h) => h.key && h.enabled).length;
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog defaults" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="muted small">
          Applies to every request in here and below. A folder overrides what's above it; a request overrides both. Saved as <code>folder.yaml</code> next to your requests.
        </p>
        <nav className="subtabs">
          {(["headers", "auth", "scripts"] as Section[]).map((s) => (
            <button key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>
              {s[0].toUpperCase() + s.slice(1)}
              {s === "headers" && count > 0 && <i>{count}</i>}
              {s === "auth" && tab.authMode !== "none" && <i>●</i>}
              {s === "scripts" && (tab.preScript.trim() || tab.postScript.trim()) && <i>●</i>}
            </button>
          ))}
        </nav>
        <div className="defaults-body">
          {section === "headers" && <KVEditor rows={tab.headers} onChange={(headers) => patch({ headers })} />}
          {section === "auth" && <AuthPanel tab={tab} patch={patch} token={undefined} busy={false} onGetToken={() => {}} onResetToken={() => {}} inheritFrom={undefined} showToken={false} />}
          {section === "scripts" && <ScriptsPanel tab={tab} patch={patch} />}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(tab)}>Save</button>
        </div>
      </div>
    </div>
  );
}
