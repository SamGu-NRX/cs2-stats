// The app bar under the native title bar. Views fill its breadcrumb and tool slots through portals,
// so each view owns its filters while the bar stays one element.
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Slots { crumbs: HTMLElement | null; tools: HTMLElement | null }
const SlotCtx = createContext<{ slots: Slots; set: (s: Slots) => void } | null>(null);

export function BarProvider({ children }: { children: ReactNode }) {
  const [slots, set] = useState<Slots>({ crumbs: null, tools: null });
  return <SlotCtx.Provider value={{ slots, set }}>{children}</SlotCtx.Provider>;
}

export function useBarSlots() {
  const c = useContext(SlotCtx);
  if (!c) throw new Error("useBarSlots outside BarProvider");
  return c;
}

export interface Crumb { label: ReactNode; href?: string }

/** Renders into the app bar: breadcrumb segments (each clickable but the last) and view tools. */
export function BarContent({ crumbs, tools }: { crumbs: Crumb[]; tools?: ReactNode }) {
  const { slots } = useBarSlots();
  return (
    <>
      {slots.crumbs && createPortal(
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} style={{ display: "contents" }}>
                {i > 0 && <span className="sep" aria-hidden>/</span>}
                {last || !c.href ? <span aria-current={last ? "page" : undefined}>{c.label}</span> : <a href={c.href}>{c.label}</a>}
              </span>
            );
          })}
        </nav>,
        slots.crumbs,
      )}
      {slots.tools && tools && createPortal(tools, slots.tools)}
    </>
  );
}
