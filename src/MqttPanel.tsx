import { useState } from "react";
import { CodeEditor, type VarMap } from "./CodeEditor";
import { Switch } from "./SettingRow";
import type { MqttQos, MqttSub, RequestTab } from "./lib/types";
import { tryPrettyJson, uid } from "./lib/util";
import { topicFilterError } from "./lib/mqtt";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  connected: boolean;
  onPublish: () => void;
  onSubscribe: (s: MqttSub) => void;
  onUnsubscribe: (s: MqttSub) => void;
};

const QosSelect = ({ value, onChange, label }: { value: MqttQos; onChange: (q: MqttQos) => void; label: string }) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value) as MqttQos)}>
    <option value={0}>QoS 0</option>
    <option value={1}>QoS 1</option>
    <option value={2}>QoS 2</option>
  </select>
);

export function MqttPanel({ tab, patch, vars, connected, onPublish, onSubscribe, onUnsubscribe }: Props) {
  const m = tab.mqtt;
  const set = (p: Partial<typeof m>) => patch({ mqtt: { ...m, ...p } });
  const [filter, setFilter] = useState("");
  const [fq, setFq] = useState<MqttQos>(0);
  const bad = filter.trim() ? topicFilterError(filter.trim()) : null;
  const add = () => {
    const topic = filter.trim();
    if (!topic || bad) return;
    const s = { id: uid(), topic, qos: fq };
    set({ subs: [...m.subs, s] });
    setFilter("");
    if (connected) onSubscribe(s);
  };
  return (
    <div className="ws mqtt">
      <div className="ws-compose">
        <div className="row tools">
          <input className="cell sio-event" aria-label="Topic to publish to" placeholder="Topic, e.g. sensors/kitchen/temp" value={m.topic} spellCheck={false} onChange={(e) => set({ topic: e.target.value })} />
          <QosSelect label="Publish QoS" value={m.qos} onChange={(qos) => set({ qos })} />
          <Switch label="Retain the message" checked={m.retain} onChange={(retain) => set({ retain })} />
          <span className="muted small">Retain</span>
          <select aria-label="Payload format" value={m.format} onChange={(e) => set({ format: e.target.value as typeof m.format })}>
            <option value="text">Text</option>
            <option value="json">JSON</option>
            <option value="hex">Hex</option>
          </select>
          <div className="spacer" />
          {m.format === "json" && <button className="btn small" onClick={() => { const p = tryPrettyJson(m.payload); if (p) set({ payload: p }); }}>Prettify</button>}
          <button className="btn primary small" disabled={!connected || !m.topic.trim()} onClick={onPublish} title={connected ? (m.topic.trim() ? "Publish (⌘↵)" : "Give the topic a name") : "Connect first"}>
            Publish <kbd>⌘↵</kbd>
          </button>
        </div>
        <CodeEditor className="boxed" lang={m.format === "json" ? "json" : "text"} label="Message payload" value={m.payload} vars={vars} placeholder={m.format === "hex" ? "48 65 6c 6c 6f" : m.format === "json" ? '{ "celsius": 21.5 }' : "Message payload"} onChange={(v) => set({ payload: v })} />
      </div>
      <aside className="ws-saved">
        <h4>Subscriptions</h4>
        <div className="saved-row">
          <input className="cell" aria-label="Topic filter to subscribe to" placeholder="sensors/#" value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <QosSelect label="Subscription QoS" value={fq} onChange={setFq} />
          <button className="btn small" disabled={!filter.trim() || !!bad} onClick={add} title={bad ?? (connected ? "Subscribe" : "Saved now, subscribed when you connect")}>Add</button>
        </div>
        {bad && <p className="muted small" role="status">{bad}</p>}
        {m.subs.length === 0 && !bad && <p className="muted small">Topics to follow. They're stored in the request file and subscribed on connect. + matches one level, # the rest.</p>}
        {m.subs.map((s) => (
          <div key={s.id} className="saved-row">
            <span className="saved-name" title={`${s.topic} (QoS ${s.qos})`}>{s.topic} <span className="muted small">QoS {s.qos}</span></span>
            <button className="icon-btn" title="Remove" aria-label={`Remove ${s.topic}`} onClick={() => { set({ subs: m.subs.filter((x) => x.id !== s.id) }); if (connected) onUnsubscribe(s); }}>×</button>
          </div>
        ))}
      </aside>
    </div>
  );
}
