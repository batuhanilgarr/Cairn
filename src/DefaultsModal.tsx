import { useState } from "react";
import type { RequestTab } from "./lib/types";
import { KVEditor } from "./KVEditor";
import { emptyKV } from "./lib/util";
import { AuthPanel } from "./AuthPanel";
import { ScriptsPanel } from "./ScriptsPanel";

type Section = "variables" | "headers" | "auth" | "scripts";

/** Edits a folder's (or the collection's) defaults: headers, auth and scripts every request below it inherits. */
export function DefaultsModal({ title, initial, onSave, onClose }: { title: string; initial: RequestTab; onSave: (t: RequestTab) => void; onClose: () => void }) {
  const [tab, setTab] = useState<RequestTab>(initial);
  const [section, setSection] = useState<Section>("variables");
  const patch = (p: Partial<RequestTab>) => setTab((t) => ({ ...t, ...p }));
  const count = tab.headers.filter((h) => h.key && h.enabled).length;
  const varCount = (tab.vars ?? []).filter((v) => v.key && v.enabled).length;
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog defaults" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="muted small">
          Applies to every request in here and below. A folder overrides what's above it; a request overrides both. Variables are defaults: an environment or a script can still override them. Saved as <code>folder.yaml</code> next to your requests.
        </p>
        <nav className="subtabs">
          {(["variables", "headers", "auth", "scripts"] as Section[]).map((s) => (
            <button key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>
              {s[0].toUpperCase() + s.slice(1)}
              {s === "variables" && varCount > 0 && <i>{varCount}</i>}
              {s === "headers" && count > 0 && <i>{count}</i>}
              {s === "auth" && tab.authMode !== "none" && <i>●</i>}
              {s === "scripts" && (tab.preScript.trim() || tab.postScript.trim()) && <i>●</i>}
            </button>
          ))}
        </nav>
        <div className="defaults-body">
          {section === "variables" && (
            <>
              <KVEditor rows={tab.vars?.length ? tab.vars : [emptyKV()]} onChange={(vars) => patch({ vars })} keyPlaceholder="Variable" />
              <p className="muted small">Use them as <code>{"{{name}}"}</code>. They are saved in <code>folder.yaml</code> and committed with the collection, so keep secrets in an environment instead.</p>
            </>
          )}
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
