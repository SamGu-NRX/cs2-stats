// Floating layers: text tooltips (any element with data-tip), rich hover cards, toasts and context
// menus. Tooltips and hover cards share one timing rule: the first waits 400 ms, and while another
// closed less than 300 ms ago the next opens instantly with no animation.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../icons/ui";

const DELAY = 400;
const LINGER = 300;
let lastHidden = 0;
let anyOpen = false;
const chained = () => anyOpen || performance.now() - lastHidden < LINGER;

function place(anchor: DOMRect, el: HTMLElement, prefer: "top" | "bottom" | "right" = "top") {
  const t = el.getBoundingClientRect();
  let top: number;
  let left: number;
  let origin: string;
  if (prefer === "right") {
    left = anchor.right + 8;
    top = Math.max(8, Math.min(innerHeight - t.height - 8, anchor.top + anchor.height / 2 - t.height / 2));
    origin = "0% 50%";
    if (left + t.width > innerWidth - 8) { left = anchor.left - t.width - 8; origin = "100% 50%"; }
  } else {
    top = prefer === "top" ? anchor.top - t.height - 8 : anchor.bottom + 8;
    origin = prefer === "top" ? "50% 100%" : "50% 0%";
    if (prefer === "top" && top < 8) { top = anchor.bottom + 8; origin = "50% 0%"; }
    if (prefer === "bottom" && top + t.height > innerHeight - 8) { top = anchor.top - t.height - 8; origin = "50% 100%"; }
    left = Math.max(8, Math.min(innerWidth - t.width - 8, anchor.left + anchor.width / 2 - t.width / 2));
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.setProperty("--tip-origin", origin);
}

/** One tooltip element for the whole app, driven by data-tip attributes. */
export function TooltipLayer() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = el.current!;
    let timer = 0;
    let current: Element | null = null;
    const show = (target: Element, instant: boolean) => {
      current?.removeAttribute("aria-describedby");
      current = target;
      target.setAttribute("aria-describedby", "app-tip");
      tip.textContent = target.getAttribute("data-tip");
      tip.classList.toggle("is-instant", instant);
      place(target.getBoundingClientRect(), tip);
      tip.classList.add("is-on");
      anyOpen = true;
    };
    const hide = () => {
      if (!current) return;
      tip.classList.remove("is-on");
      current.removeAttribute("aria-describedby");
      current = null;
      anyOpen = false;
      lastHidden = performance.now();
    };
    const enter = (e: Event) => {
      if (e instanceof PointerEvent && e.pointerType === "touch") return;
      const target = (e.target as Element).closest?.("[data-tip]");
      if (!target || target === current || !target.getAttribute("data-tip")) return;
      clearTimeout(timer);
      if (chained() || e.type === "focusin") show(target, true);
      else timer = window.setTimeout(() => show(target, false), DELAY);
    };
    const leave = (e: Event) => {
      const target = (e.target as Element).closest?.("[data-tip]");
      const to = (e as PointerEvent).relatedTarget as Element | null;
      if (!target || (to && target.contains(to))) return;
      clearTimeout(timer);
      hide();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    const scroll = () => hide();
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", key);
    addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", key);
      removeEventListener("scroll", scroll, true);
    };
  }, []);
  return <div ref={el} id="app-tip" className="tip" role="tooltip" />;
}

/**
 * A rich card shown on hover (after 400 ms) or keyboard focus. The trigger keeps its own semantics;
 * the card is described by it and never takes focus. Content renders only while open.
 */
export function HoverCard({ card, children, prefer = "bottom", className, as: Tag = "span", tabbable = true, style }: {
  card: () => ReactNode;
  children: ReactNode;
  prefer?: "top" | "bottom" | "right";
  className?: string;
  as?: "span" | "div";
  tabbable?: boolean;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<null | { instant: boolean }>(null);
  const timer = useRef(0);
  const enter = (instant: boolean) => {
    clearTimeout(timer.current);
    if (instant || chained()) setOpen({ instant: true });
    else timer.current = window.setTimeout(() => setOpen({ instant: false }), DELAY);
  };
  const leave = () => {
    clearTimeout(timer.current);
    if (open) { lastHidden = performance.now(); anyOpen = false; }
    setOpen(null);
  };
  useLayoutEffect(() => {
    if (!open || !ref.current || !cardRef.current) return;
    anyOpen = true;
    place(ref.current.getBoundingClientRect(), cardRef.current, prefer);
    requestAnimationFrame(() => cardRef.current?.classList.add("is-on"));
  }, [open, prefer]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const off = () => leave();
    addEventListener("scroll", off, true);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") leave(); };
    addEventListener("keydown", key);
    return () => { removeEventListener("scroll", off, true); removeEventListener("keydown", key); };
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const props = {
    ref: ref as never,
    className: className ? `hc-trigger ${className}` : "hc-trigger",
    style,
    tabIndex: tabbable ? 0 : undefined,
    onPointerEnter: (e: React.PointerEvent) => e.pointerType !== "touch" && enter(false),
    onPointerLeave: leave,
    onFocus: () => enter(true),
    onBlur: leave,
  };
  return (
    <>
      <Tag {...props}>{children}</Tag>
      {open && createPortal(
        <div ref={cardRef} className={`hcard tip ${open.instant ? "is-instant" : ""}`} role="tooltip">{card()}</div>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------- toasts

// Toasts: information and confirmations leave after 4 s (paused while the window is in the
// background); errors stay until dismissed and are announced as alerts. Every toast has a close
// button. Entry and exit are CSS transitions (interruptible), not keyframes.
export interface Toast { id: number; text: ReactNode; tone: "good" | "poor" | "info"; out?: boolean }
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const dismissers = new Map<number, () => void>();

export function dismissToast(id: number) { dismissers.get(id)?.(); }

export function toast(text: ReactNode, tone: Toast["tone"] = "info", ms = 4000) {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, text, tone }];
  emit();
  let left = ms;
  let started = performance.now();
  let t = 0;
  const persist = tone === "poor";
  const run = () => { if (!persist) { t = window.setTimeout(dismiss, left); started = performance.now(); } };
  const blur = () => { clearTimeout(t); left -= performance.now() - started; };
  const focus = () => run();
  function dismiss() {
    clearTimeout(t);
    dismissers.delete(id);
    removeEventListener("blur", blur);
    removeEventListener("focus", focus);
    toasts = toasts.map((x) => (x.id === id ? { ...x, out: true } : x));
    emit();
    window.setTimeout(() => { toasts = toasts.filter((x) => x.id !== id); emit(); }, 150);
  }
  dismissers.set(id, dismiss);
  addEventListener("blur", blur);
  addEventListener("focus", focus);
  run();
}

function ToastItem({ t }: { t: Toast }) {
  return (
    <div className={`toast ${t.out ? "is-out" : ""}`} data-tone={t.tone}>
      <i className="toast__dot" data-tone={t.tone} aria-hidden />
      <div className="toast__text">{t.text}</div>
      <button className="toast__close" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><CloseIcon size={14} /></button>
    </div>
  );
}

export function ToastLayer() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => toasts);
  return (
    <div className="toasts">
      <div role="status" aria-live="polite" className="toasts__group">{list.filter((t) => t.tone !== "poor").map((t) => <ToastItem key={t.id} t={t} />)}</div>
      <div role="alert" className="toasts__group">{list.filter((t) => t.tone === "poor").map((t) => <ToastItem key={t.id} t={t} />)}</div>
    </div>
  );
}

// ---------------------------------------------------------------- context menu
// A menu of focusable items (roving tabindex): arrows move, Enter or Space runs, Escape closes, and
// focus returns to where it was when the menu opened.

export interface MenuItem { label: string; run: () => void; hint?: string; disabled?: boolean }
let menu: { x: number; y: number; items: MenuItem[]; from: HTMLElement | null } | null = null;
const menuListeners = new Set<() => void>();

/** Opens the menu at a viewport position; the caller has already cancelled the browser's menu. */
export function openMenu(at: { x: number; y: number }, items: MenuItem[]) {
  menu = { x: at.x, y: at.y, items, from: document.activeElement as HTMLElement | null };
  menuListeners.forEach((l) => l());
}
const closeMenu = (restore = true) => {
  const from = menu?.from;
  menu = null;
  menuListeners.forEach((l) => l());
  if (restore) from?.focus?.({ preventScroll: true });
};

export function MenuLayer() {
  const m = useSyncExternalStore((l) => { menuListeners.add(l); return () => menuListeners.delete(l); }, () => menu);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const enabled = m ? m.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0) : [];
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.left = `${Math.min(m.x, innerWidth - r.width - 8)}px`;
    ref.current.style.top = `${Math.min(m.y, innerHeight - r.height - 8)}px`;
    setActive(enabled[0] ?? 0);
  }, [m]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (m) ref.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.focus(); }, [m, active]);
  useEffect(() => {
    if (!m) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) closeMenu(false); };
    const blur = () => closeMenu(false);
    addEventListener("pointerdown", down, true);
    addEventListener("blur", blur);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("blur", blur); };
  }, [m]);
  if (!m) return null;
  const run = (it: MenuItem) => { if (it.disabled) return; closeMenu(); it.run(); };
  const step = (d: number) => {
    const k = enabled.indexOf(active);
    setActive(enabled[(k + d + enabled.length) % enabled.length]);
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="pop menu"
      style={{ left: m.x, top: m.y }}
      // the platform may still send contextmenu for the key that opened this menu; no native menu on top
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
        else if (e.key === "Home") { e.preventDefault(); setActive(enabled[0]); }
        else if (e.key === "End") { e.preventDefault(); setActive(enabled[enabled.length - 1]); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(m.items[active]); }
        else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
      }}
    >
      {m.items.map((it, i) => (
        <div key={it.label} data-i={i} role="menuitem" tabIndex={i === active ? 0 : -1} aria-disabled={it.disabled || undefined} className="opt" data-active={i === active} onPointerMove={() => !it.disabled && setActive(i)} onClick={() => run(it)} style={it.disabled ? { opacity: 0.4 } : undefined}>
          <span>{it.label}</span>
          {it.hint && <small>{it.hint}</small>}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Copies text and confirms with a toast. */
export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("The clipboard is not available here", "poor");
  }
}
