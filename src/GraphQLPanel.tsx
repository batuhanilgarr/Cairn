import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { IntrospectionQuery } from "graphql";
import { CodeEditor, type VarMap } from "./CodeEditor";
import type { RequestTab } from "./lib/types";
import { docsFrom, loadCm6, loadGraphQL, type DocType } from "./lib/graphql";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  vars: VarMap;
  schema: IntrospectionQuery | undefined;
  fetching: boolean;
  schemaError: string | null;
  onFetchSchema: () => void;
};

export function GraphQLPanel({ tab, patch, vars, schema, fetching, schemaError, onFetchSchema }: Props) {
  const [ext, setExt] = useState<Extension | undefined>();
  const [docsOpen, setDocsOpen] = useState(false);
  const view = useRef<EditorView | null>(null);
  const g = tab.gql;
  const setG = (p: Partial<typeof g>) => patch({ gql: { ...g, ...p } });

  // Language support loads lazily, then gets the schema for completion and validation.
  useEffect(() => {
    let live = true;
    (async () => {
      const [{ graphql }, gql] = await Promise.all([loadCm6(), loadGraphQL()]);
      if (!live) return;
      setExt(graphql(schema ? gql.buildClientSchema(schema) : undefined));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [schema]);

  const docs = useMemo(() => (schema ? docsFrom(schema) : null), [schema]);

  return (
    <div className="gql">
      <div className="gql-main">
        <div className="gql-col">
          <div className="gql-head">
            <h4>Query</h4>
            <input className="cell op" placeholder="Operation name (optional)" value={g.operation} spellCheck={false} onChange={(e) => setG({ operation: e.target.value })} />
            <div className="spacer" />
            <button className="btn small" onClick={onFetchSchema} disabled={fetching || !tab.url.trim()} title="Run an introspection query against this endpoint">
              {fetching ? "Fetching…" : schema ? "Refresh schema" : "Fetch schema"}
            </button>
            <button className="btn small" disabled={!docs} onClick={() => setDocsOpen((v) => !v)}>Docs</button>
          </div>
          <CodeEditor className="boxed" value={g.query} extensions={ext} vars={vars} editorRef={view} placeholder={"query {\n  viewer {\n    id\n  }\n}"} onChange={(v) => setG({ query: v })} />
          {schemaError && <p className="err small">{schemaError}</p>}
          {!schema && !schemaError && <p className="muted small">Fetch the schema to get autocomplete, validation and docs.</p>}
        </div>
        <div className="gql-col vars">
          <h4>Variables (JSON)</h4>
          <CodeEditor className="boxed" lang="json" value={g.variables} vars={vars} placeholder={'{ "id": "1" }'} onChange={(v) => setG({ variables: v })} />
        </div>
      </div>
      {docsOpen && docs && <Docs docs={docs} onInsert={(text) => view.current?.dispatch(view.current.state.replaceSelection(text))} onClose={() => setDocsOpen(false)} />}
    </div>
  );
}

function Docs({ docs, onInsert, onClose }: { docs: ReturnType<typeof docsFrom>; onInsert: (t: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>(docs.roots.query ?? docs.types[0]?.name ?? "");
  const byName = useMemo(() => new Map(docs.types.map((t) => [t.name, t])), [docs]);
  const cur = byName.get(open);
  const baseName = (t: string) => t.replace(/[[\]!]/g, "");
  const list = docs.types.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.fields.some((f) => f.name.toLowerCase().includes(q.toLowerCase())));
  const roots = [docs.roots.query, docs.roots.mutation, docs.roots.subscription].filter(Boolean) as string[];
  return (
    <aside className="gql-docs">
      <div className="gql-docs-head">
        <b>Schema</b>
        <button className="icon-btn" onClick={onClose} aria-label="Close docs">×</button>
      </div>
      <input className="cell" placeholder="Search types and fields" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="gql-docs-body">
        <div className="gql-types">
          {roots.map((r) => (
            <button key={r} className={open === r ? "on root" : "root"} onClick={() => setOpen(r)}>{r}</button>
          ))}
          {list.filter((t) => !roots.includes(t.name)).map((t) => (
            <button key={t.name} className={open === t.name ? "on" : ""} onClick={() => setOpen(t.name)}>
              {t.name}<small>{t.kind.toLowerCase().replace("input_object", "input")}</small>
            </button>
          ))}
        </div>
        <div className="gql-type">
          {cur && <TypeView t={cur} baseName={baseName} onOpen={(n) => byName.has(n) && setOpen(n)} onInsert={onInsert} />}
        </div>
      </div>
    </aside>
  );
}

function TypeView({ t, baseName, onOpen, onInsert }: { t: DocType; baseName: (s: string) => string; onOpen: (n: string) => void; onInsert: (t: string) => void }) {
  return (
    <>
      <h4>{t.name}</h4>
      {t.description && <p className="muted small">{t.description}</p>}
      {t.enumValues.length > 0 && <p className="small">{t.enumValues.map((e) => <code key={e}>{e}</code>)}</p>}
      {t.fields.map((f) => (
        <div key={f.name} className={`gql-field ${f.deprecated ? "dep" : ""}`}>
          <button className="icon-btn" title="Insert into query" onClick={() => onInsert(f.name)}>+</button>
          <div>
            <code>{f.name}{f.args ? `(${f.args})` : ""}</code>: <a onClick={() => onOpen(baseName(f.type))}>{f.type}</a>
            {f.description && <div className="muted small">{f.description}</div>}
          </div>
        </div>
      ))}
    </>
  );
}
