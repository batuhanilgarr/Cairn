export type AsideKind = "code" | "ai";

/** Switches the right-hand panel between the code snippet and the AI assistant. */
export function AsideTabs({ active, onSelect, onClose }: { active: AsideKind; onSelect: (k: AsideKind) => void; onClose: () => void }) {
  return (
    <div className="aside-tabs">
      <div className="tl" role="tablist" aria-label="Side panel">
      <button role="tab" aria-selected={active === "code"} className={active === "code" ? "on" : ""} onClick={() => onSelect("code")}>Code</button>
      <button role="tab" aria-selected={active === "ai"} className={active === "ai" ? "on" : ""} onClick={() => onSelect("ai")}>Ask AI</button>
      </div>
      <div className="spacer" />
      <button className="icon-btn" onClick={onClose} aria-label="Close panel" title="Close">×</button>
    </div>
  );
}
