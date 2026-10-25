// Segmented control with one sliding indicator, after the Panel's. Three roles:
// - "tabs": switches the panel below (pass panelId, which the panel uses as its id);
// - "radio": picks a filter or layer;
// - "nav": top-level sections (aria-current).
// Arrow keys, Home and End move the selection. Keyboard moves never animate; pointer moves slide.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface SegOption<T extends string> { value: T; label: string; disabled?: boolean; tip?: string }

export function Segmented<T extends string>({ options, value, onChange, label, size, kind = "radio", panelId }: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm";
  kind?: "tabs" | "radio" | "nav";
  panelId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [instant, setInstant] = useState(true);

  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(`[data-v="${value}"]`);
    if (!el) return;
    const measure = () => setInd({ x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, options]);

  const enabled = options.filter((o) => !o.disabled);
  // The tab stop: the selected option, or the first enabled one if the selection is disabled.
  const stop = options.find((o) => o.value === value && !o.disabled)?.value ?? enabled[0]?.value;

  const pick = (v: T, viaKeyboard: boolean) => {
    setInstant(viaKeyboard);
    onChange(v);
  };
  const onKey = (e: KeyboardEvent) => {
    const i = enabled.findIndex((o) => o.value === value);
    const n = enabled.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined || !n) return;
    e.preventDefault();
    const next = enabled[to];
    pick(next.value, true);
    root.current?.querySelector<HTMLElement>(`[data-v="${next.value}"]`)?.focus();
  };

  const groupRole = kind === "tabs" ? "tablist" : kind === "radio" ? "radiogroup" : undefined;
  const itemRole = kind === "tabs" ? "tab" : kind === "radio" ? "radio" : undefined;
  return (
    <div ref={root} className={`seg ${size === "sm" ? "seg--sm" : ""}`} role={groupRole} aria-label={label} onKeyDown={onKey}>
      {ind && <span className={`seg__ind ${instant ? "is-instant" : ""}`} style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} aria-hidden />}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            id={panelId ? `${panelId}-tab-${o.value}` : undefined}
            data-v={o.value}
            role={itemRole}
            aria-selected={kind === "tabs" ? on : undefined}
            aria-checked={kind === "radio" ? on : undefined}
            aria-current={kind === "nav" && on ? "page" : undefined}
            aria-controls={kind === "tabs" && panelId ? panelId : undefined}
            data-on={on}
            tabIndex={o.value === stop ? 0 : -1}
            disabled={o.disabled}
            data-tip={o.tip}
            className="seg__item"
            onClick={(e) => pick(o.value, e.detail === 0)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
