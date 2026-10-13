import type { KV } from "./lib/types";
import { emptyKV } from "./lib/util";

type Props = {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Show a per-row "secret" toggle (value is kept out of Git). */
  secrets?: boolean;
};

export function KVEditor({ rows, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value", secrets }: Props) {
  const update = (id: string, patch: Partial<KV>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    const last = next[next.length - 1];
    if (last && (last.key || last.value)) next.push(emptyKV());
    onChange(next);
  };
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    onChange(next.length ? next : [emptyKV()]);
  };
  return (
    <div className="kv">
      <div className="kv-head" aria-hidden="true">
        <span className="kv-pad" />
        <span>{keyPlaceholder}</span>
        <span>{valuePlaceholder}</span>
        {secrets && <span className="kv-end" />}
        <span className="kv-end" />
      </div>
      {rows.map((r) => (
        <div className="kv-row" key={r.id}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
            aria-label="Enabled"
          />
          <input
            className="cell"
            placeholder={keyPlaceholder}
            value={r.key}
            spellCheck={false}
            onChange={(e) => update(r.id, { key: e.target.value })}
          />
          <input
            className="cell"
            placeholder={valuePlaceholder}
            value={r.value}
            type={secrets && r.secret ? "password" : "text"}
            spellCheck={false}
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          {secrets && (
            <button
              className={`icon-btn lock ${r.secret ? "on" : ""}`}
              title={r.secret ? "Secret: stored locally, never committed" : "Mark as secret"}
              onClick={() => update(r.id, { secret: !r.secret })}
            >
              {r.secret ? "🔒" : "🔓"}
            </button>
          )}
          <button className="icon-btn" onClick={() => remove(r.id)} aria-label="Remove row">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
