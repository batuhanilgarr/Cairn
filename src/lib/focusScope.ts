/**
 * Ref callback for a modal's container: moves focus into it when it opens, keeps Tab inside it,
 * and gives focus back to whatever had it before when it closes. (React 19 runs the returned cleanup.)
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

export function focusScope(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  const before = document.activeElement as HTMLElement | null;
  if (!el.contains(document.activeElement)) {
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
    const first = items.find((i) => i.matches("[data-autofocus], input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea")) ?? items.find((i) => i.matches(".btn.primary")) ?? items[0];
    (first ?? el).focus({ preventScroll: true });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
    if (!items.length) return e.preventDefault();
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  el.addEventListener("keydown", onKey);
  return () => {
    el.removeEventListener("keydown", onKey);
    if (before?.isConnected) before.focus({ preventScroll: true });
  };
}
