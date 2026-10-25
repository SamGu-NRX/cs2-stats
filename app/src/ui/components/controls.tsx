// Segmented control and select. Both follow the motion table: the segmented thumb slides 160 ms
// on pointer input and jumps on keyboard input; the select's listbox scales in from its trigger.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronIcon } from "../icons/ui";

export interface Option<T extends string> { value: T; label: ReactNode; disabled?: boolean; tip?: string; side?: "t" | "ct" }

/**
 * Where an arrow key moves in a group with one tab stop (WAI-ARIA radio group or tablist): the arrows
 * step and wrap, Home and End jump to the ends. Up and Down step too in a radio group, not in a
 * tablist. Null for any other key. `i` is the current index, -1 when none is selected.
 */
export function rovingIndex(key: string, i: number, n: number, upDown: boolean): number | null {
  if (!n) return null;
  const next = (i + 1) % n;
  const prev = i < 0 ? n - 1 : (i - 1 + n) % n;
  switch (key) {
    case "ArrowRight": return next;
    case "ArrowLeft": return prev;
    case "ArrowDown": return upDown ? next : null;
    case "ArrowUp": return upDown ? prev : null;
    case "Home": return 0;
    case "End": return n - 1;
    default: return null;
  }
}

export function Segmented<T extends string>({ options, value, onChange, label, kind = "radio", panelId }: {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  kind?: "radio" | "tabs";
  panelId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [instant, setInstant] = useState(true);
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(value)}"]`);
    if (!el) return;
    const measure = () => setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, options.length]);
  const enabled = options.filter((o) => !o.disabled);
  const pick = (v: T, keyboard: boolean) => { setInstant(keyboard); onChange(v); };
  const onKey = (e: KeyboardEvent) => {
    const to = rovingIndex(e.key, enabled.findIndex((o) => o.value === value), enabled.length, kind === "radio");
    if (to === null) return;
    e.preventDefault();
    pick(enabled[to].value, true);
    root.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(enabled[to].value)}"]`)?.focus();
  };
  const stop = options.find((o) => o.value === value && !o.disabled)?.value ?? enabled[0]?.value;
  return (
    <div ref={root} className="seg" role={kind === "tabs" ? "tablist" : "radiogroup"} aria-label={label} onKeyDown={onKey}>
      {thumb && <span className={`seg__thumb ${instant ? "is-instant" : ""}`} style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} aria-hidden />}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            data-v={o.value}
            data-on={on}
            data-side={o.side}
            className="seg__item"
            role={kind === "tabs" ? "tab" : "radio"}
            aria-checked={kind === "radio" ? on : undefined}
            aria-selected={kind === "tabs" ? on : undefined}
            aria-controls={kind === "tabs" ? panelId : undefined}
            tabIndex={o.value === stop ? 0 : -1}
            disabled={o.disabled}
            data-tip={o.tip}
            onClick={(e) => pick(o.value, e.detail === 0)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Button that opens a listbox. Arrow keys move, Enter or Space picks, Escape closes. */
export function Select<T extends string>({ options, value, onChange, label, prefix }: {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** small muted text before the value, e.g. "Map" */
  prefix?: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number }>({ left: 0, top: 0, minWidth: 0 });
  const current = options.find((o) => o.value === value);

  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    setPos({ left: Math.min(r.left, innerWidth - 220), top: r.bottom + 4, minWidth: r.width });
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setClosing(false);
    setOpen(true);
  };
  const hide = (focus = true) => {
    setClosing(true);
    window.setTimeout(() => { setOpen(false); setClosing(false); }, 100);
    if (focus) btn.current?.focus();
  };
  useEffect(() => { if (open && !closing) list.current?.focus(); }, [open, closing]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) hide(false);
    };
    addEventListener("pointerdown", down, true);
    return () => removeEventListener("pointerdown", down, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (o: Option<T>) => { if (o.disabled) return; onChange(o.value); hide(); };
  /** The next enabled option from index i in direction d, staying put at the ends. */
  const nextEnabled = (i: number, d: number) => {
    for (let j = i + d; j >= 0 && j < options.length; j += d) if (!options[j].disabled) return j;
    return Math.max(0, Math.min(options.length - 1, i));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => nextEnabled(a, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => nextEnabled(a, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(nextEnabled(-1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActive(nextEnabled(options.length, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(options[active]); }
    else if (e.key === "Tab") hide(false);
  };
  const id = `sel-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <>
      <button
        ref={btn}
        className="select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${typeof current?.label === "string" ? current.label : value}`}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(); } }}
      >
        {prefix && <span className="lbl">{prefix}</span>}
        <span>{current?.label ?? value}</span>
        <ChevronIcon size={14} />
      </button>
      {open && createPortal(
        <div
          ref={list}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          className={`pop ${closing ? "is-out" : ""}`}
          style={{ left: pos.left, top: pos.top, minWidth: Math.max(160, pos.minWidth), ["--origin" as string]: "top left" }}
          onKeyDown={onKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled}
              data-active={i === active}
              className="opt"
              style={o.disabled ? { opacity: 0.4 } : undefined}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(o)}
            >
              <span>{o.label}</span>
              {o.value === value && <CheckIcon size={14} className="opt__check" />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
