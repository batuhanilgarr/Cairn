import { useEffect, useRef, useState } from "react";
import { focusScope } from "./lib/focusScope";

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean } | "sep";

/** A small popover menu opened by an icon button. Closes on outside click, Escape, or after choosing an item. */
export function Menu({ trigger, items, title }: { trigger: React.ReactNode; items: MenuItem[]; title: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className={`icon-btn ${open ? "open" : ""}`} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </button>
      {open && (
        <div className="popmenu" role="menu">
          {items.map((it, i) =>
            it === "sep" ? (
              <div key={i} className="popmenu-sep" role="separator" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={it.danger ? "danger" : ""}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <span>{it.label}</span>
                {it.hint && <em>{it.hint}</em>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A menu opened at a point (right-click or the menu key). Closes on outside click, Escape, or after choosing an item. */
export function ContextMenu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="popmenu ctx" role="menu" aria-label={label} ref={(el) => { box.current = el; return focusScope(el); }} tabIndex={-1} style={{ position: "fixed", left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 220) }}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="popmenu-sep" role="separator" />
        ) : (
          <button key={i} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => (onClose(), it.onClick())}>
            <span>{it.label}</span>
            {it.hint && <em>{it.hint}</em>}
          </button>
        ),
      )}
    </div>
  );
}
