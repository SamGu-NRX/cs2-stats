// Pieces both Profile halves use: the section heading, the sticky Performance | Identity bar, and the
// slot for a metric the engine has announced but may not ship yet.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Percentile as Pct } from "../../../stats/compare";
import { Percentile, type PercentileKind } from "../../components/Percentile";
import { fmtMetric, hasMetric } from "../../data/engine";
import { metric } from "../../data/meta";
import type { Values } from "../../../worker/protocol";

export function SectionHead({ title, sub, id }: { title: string; sub: string; id?: string }) {
  return (
    <div className="shead">
      <h2 className="shead__t" id={id}>{title}</h2>
      <p className="shead__s">{sub}</p>
    </div>
  );
}

/**
 * After a deep link (#/profile?sec=identity) scrolls to a section, keeps the section at the top while
 * the blocks above it finish loading: their skeletons are not the height of what replaces them, so the
 * section would drift. Stops at the user's first wheel, pointer or key input, or after 4 s.
 */
export function useHoldSection(id: string, wanted: boolean, ready: boolean) {
  useEffect(() => {
    if (!wanted || !ready) return;
    const el = document.getElementById(id);
    const pane = el?.closest(".pane");
    const root = el?.parentElement;
    if (!el || !pane || !root) return;
    let held = true;
    const stop = () => { held = false; };
    const ro = new ResizeObserver(() => { if (held) el.scrollIntoView({ block: "start" }); });
    ro.observe(root);
    pane.addEventListener("wheel", stop, { passive: true });
    pane.addEventListener("pointerdown", stop);
    addEventListener("keydown", stop);
    const timer = setTimeout(stop, 4000);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
      pane.removeEventListener("wheel", stop);
      pane.removeEventListener("pointerdown", stop);
      removeEventListener("keydown", stop);
    };
  }, [id, wanted, ready]);
}

export interface SectionLink { id: string; label: string }

/**
 * The sticky bar under the title bar. Each button jumps to its section (no smooth scroll,
 * design/shell-and-motion.md); the underline follows the section in view. The underline slides on a
 * pointer click and jumps on keyboard activation or while scrolling.
 */
/** The underline's layout width; it is scaled to each button, so only transform animates. */
const LINE_BASE = 100;

export function SectionBar({ sections, caption }: { sections: SectionLink[]; caption: ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  const [active, setActive] = useState(sections[0].id);
  const [line, setLine] = useState<{ x: number; w: number } | null>(null);
  const [instant, setInstant] = useState(true);

  // Scroll spy: a one-pixel band just under the sticky bar, watched by an IntersectionObserver on the
  // pane. The section crossing the band is active; one that drops below it hands over to the section
  // before it, so a jump to the top (Home) lands back on the first.
  useEffect(() => {
    const nav = bar.current;
    const pane = nav?.closest(".pane");
    if (!nav || !pane) return;
    const set = (id: string) => setActive((cur) => { if (cur !== id) setInstant(true); return id; });
    let io: IntersectionObserver | null = null;
    const build = () => {
      io?.disconnect();
      const top = nav.offsetHeight + 24;
      const bottom = Math.max(0, pane.clientHeight - top - 1);
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const i = sections.findIndex((x) => x.id === e.target.id);
          if (e.isIntersecting) set(sections[i].id);
          else if (e.boundingClientRect.top > (e.rootBounds?.top ?? 0)) set(sections[Math.max(0, i - 1)].id);
        }
      }, { root: pane, rootMargin: `-${top}px 0px -${bottom}px 0px` });
      for (const x of sections) { const el = document.getElementById(x.id); if (el) io.observe(el); }
    };
    build();
    const ro = new ResizeObserver(build);
    ro.observe(pane);
    return () => { io?.disconnect(); ro.disconnect(); };
  }, [sections]);

  useLayoutEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>(`[data-sec="${active}"]`);
    if (!el) return;
    const measure = () => setLine({ x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  const go = (id: string, pointer: boolean) => {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
    setInstant(!pointer);
    setActive(id);
  };
  return (
    <nav ref={bar} className="secbar" aria-label="Profile sections">
      <div className="secbar__tabs">
        {sections.map((s) => (
          <button key={s.id} data-sec={s.id} className="secbar__btn" aria-current={s.id === active ? "true" : undefined} onClick={(e) => go(s.id, e.detail > 0)}>
            {s.label}
          </button>
        ))}
        {line && <span className={`secbar__line ${instant ? "is-instant" : ""}`} style={{ transform: `translateX(${line.x}px) scaleX(${line.w / LINE_BASE})` }} aria-hidden />}
      </div>
      <span className="secbar__cap">{caption}</span>
    </nav>
  );
}

/**
 * A metric the engine has announced but may not have shipped (design brief: buy deviation, save
 * conversion). It renders the shared percentile row once the engine defines the metric and returns a
 * value, and nothing before that: no placeholder.
 */
export function MetricSlot({ id, values, ranks, kind, population, sample, provisional }: {
  id: string;
  values: Values;
  /** the percentiles the metric's kind ranks against (compare for performance, style for identity) */
  ranks: Record<string, Pct> | null;
  kind: PercentileKind;
  population: string;
  sample?: string;
  /** a short chip beside the row while the sample is small */
  provisional?: string;
}) {
  if (!hasMetric(id)) return null;
  const v = values[id];
  if (v === null || v === undefined) return null;
  const p = ranks?.[id];
  return (
    <div className="mslot">
      {provisional ? <span className="chip chip--prov" tabIndex={0} data-tip={`${provisional}: the value can move a lot as you play more.`}>Provisional</span> : null}
      <Percentile {...pctProps(id, p, v)} kind={kind} population={population} sample={sample} />
    </div>
  );
}

/** A formatted value split into number and unit, so the unit sets small: "15.4%" → ["15.4", "%"]. */
export function splitUnit(text: string): { value: string; unit?: string } {
  const m = /^([−+-]?\$?[\d.,]+)(\s?(?:%|ms|s|°))$/.exec(text);
  return m ? { value: m[1], unit: m[2] } : { value: text };
}

/** The percentile row's props for one metric, from a metric value and its engine percentile. */
export function pctProps(id: string, p: Pct | undefined, value: number | null | undefined) {
  const m = metric(id);
  const v = value ?? p?.value ?? null;
  const text = v === null ? null : splitUnit(fmtMetric(id, v));
  return {
    label: m.label,
    value: text?.value ?? null,
    unit: text?.unit,
    pct: p?.pct ?? null,
    def: m.def,
    approx: m.status === "approx",
    reason: p?.reason ?? null,
    // a missing value with no reason means the matches hold none of it (no 1v1s, no AWP duels)
    unavailable: v === null && !p?.reason ? "None in these matches" : undefined,
  };
}
