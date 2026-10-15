import { CodeEditor, type VarMap } from "./CodeEditor";
import { Switch } from "./SettingRow";
import type { RequestTab } from "./lib/types";
import { tryPrettyJson, uid } from "./lib/util";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  connected: boolean;
  onEmit: (event: string, args: string, ack: boolean) => void;
  onAskName: () => Promise<string | null>;
};

export function SioPanel({ tab, patch, vars, connected, onEmit, onAskName }: Props) {
  const s = tab.sio;
  const set = (p: Partial<typeof s>) => patch({ sio: { ...s, ...p } });
  const ready = connected && !!s.event.trim();
  return (
    <div className="ws sio">
      <div className="ws-compose">
        <div className="row tools">
          <input className="cell sio-event" aria-label="Event name" placeholder="Event name, e.g. chat message" value={s.event} spellCheck={false} onChange={(e) => set({ event: e.target.value })} />
          <Switch label="Ask for an acknowledgement" checked={s.ack} onChange={(ack) => set({ ack })} />
          <span className="muted small">Acknowledgement</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => { const p = tryPrettyJson(s.composer); if (p) set({ composer: p }); }}>Prettify</button>
          <button className="btn small" disabled={!s.event.trim()} onClick={async () => {
            const name = await onAskName();
            if (name) set({ messages: [...s.messages, { id: uid(), name, event: s.event, body: s.composer }] });
          }}>Save message</button>
          <button className="btn primary small" disabled={!ready} onClick={() => onEmit(s.event, s.composer, s.ack)} title={connected ? (s.event.trim() ? "Emit (⌘↵)" : "Give the event a name") : "Connect first"}>
            Emit <kbd>⌘↵</kbd>
          </button>
        </div>
        <CodeEditor className="boxed" lang="json" label="Event arguments" value={s.composer} vars={vars} placeholder='[{ "room": "lobby", "text": "hello" }]  (a JSON array: each item is one argument)' onChange={(v) => set({ composer: v })} />
      </div>
      <aside className="ws-saved">
        <h4>Saved messages</h4>
        {s.messages.length === 0 && <p className="muted small">Save events you emit often. They're stored in the request file.</p>}
        {s.messages.map((m) => (
          <div key={m.id} className="saved-row">
            <button className="saved-name" title={`${m.event} ${m.body}`} onClick={() => set({ event: m.event, composer: m.body })}>{m.name}</button>
            <button className="icon-btn" title="Emit now" aria-label={`Emit ${m.name} now`} disabled={!connected} onClick={() => onEmit(m.event, m.body, s.ack)}>➤</button>
            <button className="icon-btn" title="Remove" aria-label={`Remove ${m.name}`} onClick={() => set({ messages: s.messages.filter((x) => x.id !== m.id) })}>×</button>
          </div>
        ))}
      </aside>
    </div>
  );
}
