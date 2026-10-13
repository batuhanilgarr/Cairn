import type { FormPart } from "./lib/types";
import { basename, pickAnyFile } from "./lib/fs";
import { emptyPart } from "./lib/util";

type Props = { rows: FormPart[]; onChange: (rows: FormPart[]) => void };

/** Fields of a multipart/form-data body. A field is either text or a file picked from disk. */
export function MultipartEditor({ rows, onChange }: Props) {
  const update = (id: string, patch: Partial<FormPart>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    const last = next[next.length - 1];
    if (last && (last.key || last.value)) next.push(emptyPart());
    onChange(next);
  };
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    onChange(next.length ? next : [emptyPart()]);
  };
  const choose = async (r: FormPart) => {
    const path = await pickAnyFile(`Choose a file for “${r.key || "field"}”`);
    if (path) update(r.id, { value: path, key: r.key || "file" });
  };
  return (
    <div className="kv">
      {rows.map((r) => (
        <div className="kv-row mp-row" key={r.id}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} aria-label="Enabled" />
          <input className="cell" placeholder="Field name" value={r.key} spellCheck={false} onChange={(e) => update(r.id, { key: e.target.value })} />
          <select className="cell mp-kind" value={r.kind} aria-label="Field type" onChange={(e) => update(r.id, { kind: e.target.value as FormPart["kind"], value: "" })}>
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>
          {r.kind === "file" ? (
            <button className="cell mp-file" title={r.value || "Choose a file"} onClick={() => choose(r)}>
              {r.value ? basename(r.value) : "Choose file…"}
            </button>
          ) : (
            <input className="cell" placeholder="Value" value={r.value} spellCheck={false} onChange={(e) => update(r.id, { value: e.target.value })} />
          )}
          <input className="cell mp-ct" placeholder="Content-Type (optional)" value={r.contentType ?? ""} spellCheck={false} onChange={(e) => update(r.id, { contentType: e.target.value })} />
          <button className="icon-btn" onClick={() => remove(r.id)} aria-label="Remove field">×</button>
        </div>
      ))}
    </div>
  );
}
