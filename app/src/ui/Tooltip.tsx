// One tooltip element for the whole app. Any element with data-tip shows it on hover or keyboard
// focus: 400 ms delay for the first, then instant while moving between tips.
import { useEffect, useRef } from "react";

const DELAY = 400;
const LINGER = 300;

export function TooltipLayer() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = el.current!;
    let timer = 0;
    let hideTimer = 0;
    let shown = false;
    let current: Element | null = null;

    const place = (target: Element) => {
      const r = target.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let top = r.top - t.height - 8;
      let origin = "50% 100%";
      if (top < 8) { top = r.bottom + 8; origin = "50% 0%"; }
      const left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
      tip.style.transform = "";
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.style.setProperty("--tip-origin", origin);
    };
    const show = (target: Element, instant: boolean) => {
      current?.removeAttribute("aria-describedby");
      current = target;
      target.setAttribute("aria-describedby", "app-tip");
      tip.textContent = target.getAttribute("data-tip");
      tip.classList.toggle("is-instant", instant);
      place(target);
      tip.classList.add("is-on");
      shown = true;
    };
    const hide = () => {
      tip.classList.remove("is-on");
      current?.removeAttribute("aria-describedby");
      current = null;
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => (shown = false), LINGER);
    };
    const enter = (e: Event) => {
      // Touch fires pointerover on tap; only a hovering mouse or pen, or keyboard focus, shows tips.
      if (e instanceof PointerEvent && e.pointerType === "touch") return;
      const target = (e.target as Element).closest?.("[data-tip]");
      if (!target || target === current) return;
      clearTimeout(timer);
      clearTimeout(hideTimer);
      if (shown || e.type === "focusin") show(target, true);
      else timer = window.setTimeout(() => show(target, false), DELAY);
    };
    const leave = (e: Event) => {
      const target = (e.target as Element).closest?.("[data-tip]");
      const to = (e as PointerEvent).relatedTarget as Element | null;
      if (!target || (to && target.contains(to))) return;
      clearTimeout(timer);
      if (current) hide();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && current && hide();
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", key);
    addEventListener("scroll", () => current && hide(), true);
    return () => {
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return <div ref={el} id="app-tip" className="tip" role="tooltip" />;
}
