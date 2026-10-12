import { CodeEditor, type VarMap } from "./CodeEditor";
import { pickFile, pickFolder } from "./lib/fs";
import { methodKind, type GrpcMethod, type GrpcService } from "./lib/stream";
import type { RequestTab } from "./lib/types";

export type GrpcSchema = { services: GrpcService[]; loading: boolean; error: string | null };

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  schema: GrpcSchema | undefined;
  active: boolean;
  onLoad: () => void;
  onSendMore: (text: string) => void;
  onEndStream: () => void;
};

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function GrpcPanel({ tab, patch, vars, schema, active, onLoad, onSendMore, onEndStream }: Props) {
  const g = tab.grpc;
  const set = (p: Partial<typeof g>) => patch({ grpc: { ...g, ...p } });
  const methods: GrpcMethod[] = schema?.services.flatMap((s) => s.methods) ?? [];
  const current = methods.find((m) => m.fullName === g.method);

  return (
    <div className="grpc">
      <div className="grpc-top">
        <div className="seg">
          <button className={g.source === "reflection" ? "on" : ""} onClick={() => set({ source: "reflection" })}>Server reflection</button>
          <button className={g.source === "proto" ? "on" : ""} onClick={() => set({ source: "proto" })}>.proto files</button>
        </div>
        <button className="btn small" onClick={onLoad} disabled={schema?.loading || (g.source === "reflection" ? !tab.url.trim() : g.protoFiles.length === 0)}>
          {schema?.loading ? "Loading…" : schema?.services.length ? "Reload schema" : "Load schema"}
        </button>
        {schema?.services.length ? <span className="muted small">{methods.length} methods in {schema.services.length} service{schema.services.length > 1 ? "s" : ""}</span> : null}
      </div>

      {g.source === "proto" && (
        <div className="grpc-files">
          {g.protoFiles.map((f) => (
            <div key={f} className="file-chip" title={f}>
              {base(f)}
              <button className="icon-btn" onClick={() => set({ protoFiles: g.protoFiles.filter((x) => x !== f) })} aria-label="Remove">×</button>
            </div>
          ))}
          <button className="btn small" onClick={async () => { const f = await pickFile("Choose a .proto file", ["proto"]); if (f && !g.protoFiles.includes(f)) set({ protoFiles: [...g.protoFiles, f] }); }}>Add .proto…</button>
          <button className="btn small" title="Folders searched for imports (defaults to each file's own folder)" onClick={async () => { const d = await pickFolder("Add an import path"); if (d && !g.importPaths.includes(d)) set({ importPaths: [...g.importPaths, d] }); }}>
            Import path…
          </button>
          {g.importPaths.map((d) => (
            <div key={d} className="file-chip alt" title={d}>
              {base(d)}/
              <button className="icon-btn" onClick={() => set({ importPaths: g.importPaths.filter((x) => x !== d) })} aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      )}

      {schema?.error && <p className="err small">{schema.error}</p>}
      {!schema && <p className="muted small">{g.source === "reflection" ? "Enter the server address, then load its schema through reflection." : "Add your .proto files, then load the schema."}</p>}

      <div className="grpc-method">
        {methods.length > 0 ? (
          <select value={g.method} onChange={(e) => {
            const m = methods.find((x) => x.fullName === e.target.value);
            set({ method: e.target.value, ...(m && (!g.message.trim() || g.message.trim() === "{}") ? { message: JSON.stringify(m.template, null, 2) } : {}) });
          }}>
            <option value="">Select a method…</option>
            {schema!.services.map((s) => (
              <optgroup key={s.name} label={s.name}>
                {s.methods.map((m) => (
                  <option key={m.fullName} value={m.fullName}>{m.name} · {methodKind(m)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input className="cell" placeholder="package.Service/Method" value={g.method} spellCheck={false} onChange={(e) => set({ method: e.target.value })} />
        )}
        {current && <button className="btn small" onClick={() => set({ message: JSON.stringify(current.template, null, 2) })}>Insert template</button>}
        {current && <span className="muted small">{current.inputType} → {current.outputType}</span>}
        <div className="spacer" />
        {active && current?.clientStreaming && (
          <>
            <button className="btn small" onClick={() => onSendMore(g.message)}>Send message</button>
            <button className="btn small" onClick={onEndStream}>End stream</button>
          </>
        )}
      </div>
      <CodeEditor className="boxed" lang="json" value={g.message} vars={vars} placeholder="{ }" onChange={(v) => set({ message: v })} />
    </div>
  );
}
