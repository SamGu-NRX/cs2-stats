// Career aim: how your aim moves across recorded matches, then every recorded shot together, and
// every gun you have used (the Weapons table, over every career match).
import { useMemo } from "react";
import { Delta } from "../components/bits";
import { Card } from "../components/Card";
import { TrendLine } from "../components/charts";
import { careerEntries, fmtMetric } from "../data/engine";
import { useCall, useRollups, useYourQuery } from "../data/hooks";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import { AimIcon } from "../icons/ui";
import { fmtMatchDay, plural } from "../lib/format";
import { BENCH } from "../lib/verdict";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { aimTip } from "./aim/tips";
import { Hint } from "./match/glyphs";
import { Empty, NeedsDemo, SectionAside } from "./shared";

/** Aim metrics drawn per match; bench is a reference line on the chart. */
const TRENDS: { id: string; bench?: number }[] = [
  { id: "accuracy", bench: BENCH.acc.ref },
  { id: "firstBulletAccuracy" },
  { id: "counterStrafe" },
];

/** A per-match slope in the metric's unit: percentages move in points. */
const perMatch = (id: string, v: number) => (metric(id).unit === "pct" ? `${v.toFixed(1)} pts` : fmtMetric(id, v)) + " a match";

export default function CareerAim() {
  const { matches } = useData();
  const { map, n } = useFilters();
  const career = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const list = useMemo(() => { const f = careerEntries(matches, map).filter((s) => s.hasAim); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const all = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const visibility = list.some((s) => s.match.visibility === "ok");
  const shots = list.reduce((t, s) => t + s.shots, 0);
  const oldestFirst = useMemo(() => [...list].reverse(), [list]);
  // each metric's value per match comes with the match list; the slope over them is the engine's trend()
  const series = useMemo(() => TRENDS.map((t) => oldestFirst.map((s) => s.line.v[t.id])), [oldestFirst]);
  const trends = useCall("trends", list.length ? [series] : null).data;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Career aim" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in careeraim">
        {!query ? (
          <Card><Empty icon={<AimIcon size={40} />} text={<NeedsDemo detail="Aim comes from recorded shots; converted logs have none." />} /></Card>
        ) : (
          <>
            <div className="aim-head">
              <div>
                <h1 className="section-title">Your aim over {plural(list.length, "recorded match", "recorded matches")}<Hint tip="Converted logs have no shots, so they are left out." /></h1>
                <p className="meta">{plural(shots, "gun shot")}</p>
              </div>
              <div className="toolbar__end">
                <SectionAside label="Visibility" value={visibility ? "Measured" : "Not in these files"} color={visibility ? "var(--good-text)" : "var(--ink2)"} />
              </div>
            </div>
            <div className="trends">
              {TRENDS.map((t, k) => {
                const m = metric(t.id);
                const pts = oldestFirst.map((s, i) => ({ key: s.file, value: series[k][i], label: fmtMatchDay(s.match) }));
                const tr = trends?.[k] ?? null;
                const fmt = (v: number) => fmtMetric(t.id, v);
                const better = tr && (m.lowerIsBetter ? tr.slope < 0 : tr.slope > 0);
                return (
                  <Card key={t.id} title={<span data-tip={aimTip(t.id)} tabIndex={0}>{m.label}</span>} aside={
                    <span className="trend-aside">
                      {!trends ? null : tr === null ? <span className="meta" data-tip="A trend needs three recorded matches with a value" tabIndex={0}>No trend yet</span> : (
                        <span className="trend-move" data-tip={`Least-squares change per match over ${tr.n} matches`} tabIndex={0}>
                          <span className="meta">{tr.slope === 0 ? "Steady" : better ? "Improving" : "Slipping"}</span>
                          <Delta d={tr.slope} span={Math.abs(tr.slope) || 1} lowerIsBetter={m.lowerIsBetter} fmt={(v) => perMatch(t.id, v)} />
                        </span>
                      )}
                      <b className="num cream">{fmtMetric(t.id, all ? all.v[t.id] : null)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={m.lowerIsBetter} />
                  </Card>
                );
              })}
            </div>
            <AimPanels query={query} label={plural(list.length, "match", "matches")} visibility={visibility} guns={career} />
          </>
        )}
      </div>
    </div>
  );
}
