import { useState } from "react";
import { CodeEditor, type VarMap } from "./CodeEditor";
import type { RequestTab } from "./lib/types";
import { tryPrettyJson, uid } from "./lib/util";

export type WsMode = "text" | "json" | "binary";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  connected: boolean;
  onSend: (body: string, mode: WsMode) => void;
  onAskName: () => Promise<string | null>;
};

export function WsPanel({ tab, patch, vars, connected, onSend, onAskName }: Props) {
  const [mode, setMode] = useState<WsMode>("json");
  const w = tab.ws;
  const set = (p: Partial<typeof w>) => patch({ ws: { ...w, ...p } });
  return (
    <div className="ws">
      <div className="ws-compose">
        <div className="row tools">
          <select value={mode} onChange={(e) => setMode(e.target.value as WsMode)}>
            <option value="text">Text</option>
            <option value="json">JSON</option>
            <option value="binary">Binary (base64)</option>
          </select>
          {mode === "json" && (
            <button className="btn small" onClick={() => { const p = tryPrettyJson(w.composer); if (p) set({ composer: p }); }}>Prettify</button>
          )}
          <div className="spacer" />
          <button className="btn small" disabled={!w.composer.trim()} onClick={async () => {
            const name = await onAskName();
            if (name) set({ messages: [...w.messages, { id: uid(), name, body: w.composer }] });
          }}>Save message</button>
          <button className="btn primary small" disabled={!connected || !w.composer.trim()} onClick={() => onSend(w.composer, mode)} title={connected ? "Send (⌘↵)" : "Connect first"}>
            Send <kbd>⌘↵</kbd>
          </button>
        </div>
        <CodeEditor className="boxed" lang={mode === "json" ? "json" : "text"} value={w.composer} vars={vars} placeholder={mode === "binary" ? "SGVsbG8=" : mode === "json" ? '{ "type": "subscribe", "channel": "prices" }' : "Message to send"} onChange={(v) => set({ composer: v })} />
      </div>
      <aside className="ws-saved">
        <h4>Saved messages</h4>
        {w.messages.length === 0 && <p className="muted small">Save messages you send often. They're stored in the request file.</p>}
        {w.messages.map((m) => (
          <div key={m.id} className="saved-row">
            <button className="saved-name" title={m.body} onClick={() => set({ composer: m.body })}>{m.name}</button>
            <button className="icon-btn" title="Send now" disabled={!connected} onClick={() => onSend(m.body, tryPrettyJson(m.body) !== null ? "json" : "text")}>➤</button>
            <button className="icon-btn" title="Remove" onClick={() => set({ messages: w.messages.filter((x) => x.id !== m.id) })}>×</button>
          </div>
        ))}
      </aside>
    </div>
  );
}
