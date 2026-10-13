import { useEffect, useRef, useState } from "react";

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
