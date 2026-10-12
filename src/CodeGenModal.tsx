import { useEffect, useMemo, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { LANGS, type Snippet } from "./lib/codegen";
import { load, save } from "./lib/util";

type Props = { build: (resolveVars: boolean) => Snippet; onClose: () => void };

/** "Generate code": the request as a snippet in 14 languages, with variables resolved or kept as {{name}}. */
export function CodeGenModal({ build, onClose }: Props) {
  const [lang, setLang] = useState<string>(() => load("rq.codelang", "curl"));
  const [resolve, setResolve] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => save("rq.codelang", lang), [lang]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const out = useMemo(() => {
    try {
      const l = LANGS.find((x) => x.id === lang) ?? LANGS[0];
      return { code: l.gen(build(resolve)), error: null as string | null };
    } catch (e) {
      return { code: "", error: String((e as Error).message ?? e) };
    }
  }, [lang, resolve, build]);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="codegen" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Generate code">
        <nav className="codegen-langs">
          <h3>Generate code</h3>
          {LANGS.map((l) => (
            <button key={l.id} className={l.id === lang ? "on" : ""} onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </nav>
        <div className="codegen-body">
          <div className="row tools">
            <label className="check">
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Resolve variables
            </label>
            <div className="spacer" />
            <button
              className="btn small primary"
              disabled={!!out.error}
              onClick={() => {
                void navigator.clipboard.writeText(out.code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
          {out.error ? <p className="err">{out.error}</p> : <CodeEditor readOnly wrap className="boxed fill" lang="text" value={out.code} />}
          {resolve && <p className="muted small">Secrets are included as plain text. Turn off "Resolve variables" before sharing a snippet.</p>}
        </div>
      </div>
    </div>
  );
}
