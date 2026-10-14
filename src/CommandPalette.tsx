import { useEffect, useMemo, useRef, useState } from "react";
import { focusScope } from "./lib/focusScope";

export type Command = { id: string; title: string; hint?: string; group: string; run: () => void };

/** Subsequence match with a bonus for word starts and contiguous runs. -1 = no match. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i === -1) return -1;
    run = i === ti ? run + 1 : 0;
    s += 1 + run * 2 + (i === 0 || /[\s/\-_.:]/.test(t[i - 1]) ? 4 : 0) - Math.min(i - ti, 5) * 0.1;
    ti = i + 1;
  }
  return s - t.length * 0.01;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!q.trim()) return commands.slice(0, 40);
    return commands
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, `${c.group} ${c.title}`) - 1, c.hint ? score(q, c.hint) - 2 : -1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };

  return (
    <div className="scrim top" onMouseDown={onClose}>
      <div className="palette" ref={focusScope} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          autoFocus
          className="pal-input"
          placeholder="Search requests, environments and actions…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(results[sel]); }
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="pal-list" ref={list}>
          {results.length === 0 && <p className="muted pad">No matches.</p>}
          {results.map((c, i) => (
            <button key={c.id} className={`pal-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="pal-group">{c.group}</span>
              <span className="pal-title">{c.title}</span>
              {c.hint && <span className="pal-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
