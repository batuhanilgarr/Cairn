import type { KV } from "./lib/types";
import { emptyKV } from "./lib/util";

type Props = {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
};

export function KVEditor({ rows, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value" }: Props) {
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
            spellCheck={false}
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          <button className="icon-btn" onClick={() => remove(r.id)} aria-label="Remove row">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
