// Career aim: how your aim moves across recorded matches, then every recorded shot together.
import { useMemo } from "react";
import { Card } from "../components/Card";
import { TrendLine } from "../components/charts";
import { careerEntries, fmtMetric } from "../data/engine";
import { useCall, useRollups, useYourQuery } from "../data/hooks";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import { AimIcon } from "../icons/ui";
import { fmtMatchDay, plural } from "../lib/format";
import { BENCH } from "../lib/verdict";
import { pageHref } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { Delta, Empty, NeedsDemo, SectionAside } from "./shared";

/**
 * Aim metrics drawn per match; bench is a reference line on the chart. Spray path vs pros is an
 * identity metric (a comparison with pros, not a grade), so its change is shown without a verdict.
 */
const TRENDS: { id: string; bench?: number }[] = [
  { id: "accuracy", bench: BENCH.acc.ref },
  { id: "headAccuracy" },
  { id: "firstBulletAccuracy" },
  { id: "sprayDeviation" },
  { id: "counterStrafe" },
];

export default function CareerAim() {
  const { matches } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = careerEntries(matches, map).filter((s) => s.hasAim); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const career = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
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
          <Card><Empty icon={<AimIcon size={40} />} text={<NeedsDemo detail="Aim comes from recorded shots; converted logs have none." />} action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="aim-head">
              <div>
                <h1 className="section-title">Your aim over {plural(list.length, "recorded match", "recorded matches")}</h1>
                <p className="meta">{plural(shots, "shot")} with guns. Converted logs are left out because they have no shots.</p>
              </div>
              <div className="toolbar__end">
                <SectionAside label="Accuracy" value={fmtMetric("accuracy", career ? career.v.accuracy : null)} color="var(--cream)" />
                <SectionAside label="Visibility" value={visibility ? "Measured" : "Not in these files"} color={visibility ? "var(--good-text)" : "var(--ink2)"} />
              </div>
            </div>
            <div className="trends">
              {TRENDS.map((t, k) => {
                const m = metric(t.id);
                const pts = oldestFirst.map((s, i) => ({ key: s.file, value: series[k][i], label: fmtMatchDay(s.match) }));
                const tr = trends?.[k] ?? null;
                const fmt = (v: number) => fmtMetric(t.id, v);
                const graded = m.kind === "performance";
                const better = tr && (m.lowerIsBetter ? tr.slope < 0 : tr.slope > 0);
                const word = !tr || tr.slope === 0 ? "Steady" : !graded ? (tr.slope > 0 ? "Rising" : "Falling") : better ? "Improving" : "Slipping";
                const changeTip = tr ? `Change per match over ${tr.n} matches (least-squares slope)` : undefined;
                return (
                  <Card key={t.id} title={m.label} aside={
                    <span className="trend-aside">
                      {tr && (graded
                        ? <Delta d={tr.slope} span={Math.abs(tr.slope) || 1} lowerIsBetter={m.lowerIsBetter} fmt={fmt} title={changeTip} />
                        : <span className="delta faint" data-tip={changeTip}>{tr.slope > 0 ? "+" : tr.slope < 0 ? "−" : ""}{fmt(Math.abs(tr.slope))}</span>)}
                      <b className="num cream" data-tip={m.def}>{fmtMetric(t.id, career ? career.v[t.id] : null)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={m.lowerIsBetter} />
                    <p className="meta trend-note">{!trends ? "" : tr === null ? "Three recorded matches with a value are needed to show a trend." : `${word}: ${fmt(Math.abs(tr.slope))} per match over ${tr.n} matches.`}</p>
                  </Card>
                );
              })}
            </div>
            <AimPanels query={query} label={plural(list.length, "match", "matches")} visibility={visibility} statuses={list.map((s) => s.match.visibility)} />
          </>
        )}
      </div>
    </div>
  );
}
