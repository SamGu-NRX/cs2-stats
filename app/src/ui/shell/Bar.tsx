// The title bar. Views fill its breadcrumb and its scope controls through portals, so each view owns
// what it shows while the bar stays one element.
//
//   <BarContent crumbs={[{ label: name }, { label: "Profile" }]} scope={{ controls: ["map", "matches"] }} />
//
// `scope` declares the view's scope controls (shell/filters.tsx explains the API); `tools` is for
// anything else a view needs in the bar, after them. Every crumb but the last links; the first ones
// truncate at about 18 characters, the last never does.
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ScopeControls, type ScopeDecl } from "./filters";

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

export interface Crumb { label: ReactNode; href?: string; /** full text when the label truncates */ title?: string }

/** Renders into the title bar: breadcrumb segments, the view's scope controls, then its other tools. */
export function BarContent({ crumbs, scope, tools }: { crumbs: Crumb[]; scope?: ScopeDecl; tools?: ReactNode }) {
  const { slots } = useBarSlots();
  return (
    <>
      {slots.crumbs && createPortal(
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} className={`crumb ${last ? "crumb--last" : ""}`}>
                {i > 0 && <span className="sep" aria-hidden>/</span>}
                {last || !c.href
                  ? <span className="crumb__t" aria-current={last ? "page" : undefined} data-tip={c.title}>{c.label}</span>
                  : <a className="crumb__t" href={c.href} data-tip={c.title}>{c.label}</a>}
              </span>
            );
          })}
        </nav>,
        slots.crumbs,
      )}
      {slots.tools && (scope || tools) && createPortal(<>{scope && <ScopeControls {...scope} />}{tools}</>, slots.tools)}
    </>
  );
}
