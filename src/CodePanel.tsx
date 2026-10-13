import { useEffect, useMemo, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { LANGS, type Snippet } from "./lib/codegen";
import { load, save } from "./lib/util";

type Props = {
  build: (resolveVars: boolean) => Snippet;
  onClose: () => void;
  /** Set for request types that have no HTTP snippet (WebSocket, gRPC): explains why instead of showing code. */
  unsupported?: string;
};

/** Docked next to the request, like Postman's code pane: the current request as code in any of 14 languages, updated as you edit. */
export function CodePanel({ build, onClose, unsupported }: Props) {
  const [lang, setLang] = useState<string>(() => load("rq.codelang", "curl"));
  const [resolve, setResolve] = useState<boolean>(() => load("rq.coderesolve", true));
  const [copied, setCopied] = useState(false);
  useEffect(() => save("rq.codelang", lang), [lang]);
  useEffect(() => save("rq.coderesolve", resolve), [resolve]);

  const out = useMemo(() => {
    if (unsupported) return { code: "", error: null as string | null };
    try {
      const l = LANGS.find((x) => x.id === lang) ?? LANGS[0];
      return { code: l.gen(build(resolve)), error: null as string | null };
    } catch (e) {
      return { code: "", error: String((e as Error).message ?? e) };
    }
  }, [lang, resolve, build, unsupported]);

  return (
    <aside className="codepanel" aria-label="Code snippet">
      <div className="codepanel-head">
        <strong>Code</strong>
        <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
        <div className="spacer" />
        <button
          className="btn small primary"
          disabled={!!out.error || !!unsupported}
          onClick={() => {
            void navigator.clipboard.writeText(out.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close code panel" title="Close (⇧⌘G)">×</button>
      </div>
      <label className="check codepanel-opt">
        <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Resolve variables
      </label>
      {unsupported ? (
        <p className="muted codepanel-note">{unsupported}</p>
      ) : out.error ? (
        <p className="err codepanel-note">{out.error}</p>
      ) : (
        <div className="codepanel-code">
          <CodeEditor readOnly wrap lang="text" value={out.code} className="fill" />
        </div>
      )}
      {resolve && !unsupported && <p className="muted small codepanel-note">Secrets are included as plain text. Turn off "Resolve variables" before sharing a snippet.</p>}
    </aside>
  );
}
