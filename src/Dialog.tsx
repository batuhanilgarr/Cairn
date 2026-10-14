import { useEffect, useRef, useState } from "react";
import { focusScope } from "./lib/focusScope";

export type DialogState =
  | { kind: "prompt"; title: string; label?: string; initial: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: "info"; title: string; message: string; resolve: () => void }
  | { kind: "menu"; title: string; options: { id: string; label: string; hint?: string }[]; resolve: (v: string | null) => void };

export function Dialog({ state }: { state: DialogState | null }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state?.kind === "prompt") {
      setValue(state.initial);
      setTimeout(() => input.current?.select(), 0);
    }
  }, [state]);

  if (!state) return null;
  const cancel = () =>
    state.kind === "prompt" || state.kind === "menu" ? state.resolve(null) : state.kind === "confirm" ? state.resolve(false) : state.resolve();
  const ok = () => {
    if (state.kind === "menu") return;
    if (state.kind === "prompt") state.resolve(value.trim() || null);
    else if (state.kind === "confirm") state.resolve(true);
    else state.resolve();
  };

  return (
    <div className="scrim" onMouseDown={cancel} onKeyDown={(e) => e.key === "Escape" && cancel()}>
      <div className="dialog" ref={focusScope} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={state.title}>
        <h3>{state.title}</h3>
        {state.kind === "prompt" && (
          <>
            {state.label && <p className="muted">{state.label}</p>}
            <input
              ref={input}
              className="cell"
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok()}
            />
          </>
        )}
        {state.kind === "menu" && (
          <div className="menu">
            {state.options.map((o) => (
              <button key={o.id} className="menu-item" onClick={() => state.resolve(o.id)}>
                <span>{o.label}</span>
                {o.hint && <small className="muted">{o.hint}</small>}
              </button>
            ))}
          </div>
        )}
        {(state.kind === "confirm" || state.kind === "info") && <p className="muted pre">{state.message}</p>}
        <div className="dialog-actions">
          {(state.kind === "prompt" || state.kind === "confirm") && (
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
          {state.kind !== "menu" && (
            <button
              className={`btn ${state.kind === "confirm" && state.danger ? "danger" : "primary"}`}
              autoFocus={state.kind !== "prompt"}
              onClick={ok}
            >
              {state.kind === "info" ? "OK" : state.confirm}
            </button>
          )}
          {state.kind === "menu" && (
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
