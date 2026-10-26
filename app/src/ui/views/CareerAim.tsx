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
import { tipOf } from "../data/tips";
import { AimIcon } from "../icons/ui";
import { fmtMatchDay, plural } from "../lib/format";
import { pageHref } from "../router";
import { BENCH } from "../lib/verdict";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { Hint } from "./match/glyphs";
import { Empty, NeedsDemo, SectionAside } from "./shared";

/** Aim metrics drawn per match; bench is a reference line on the chart. */
const TRENDS: { id: string; bench?: number }[] = [
  { id: "accuracy", bench: BENCH.acc.ref },
  { id: "firstBulletAccuracy" },
  { id: "counterStrafe" },
  // main's "Head accuracy" trend: the engine's headAccuracy, gun hits on the head of all gun hits
  { id: "headAccuracy" },
];

/** A per-match slope in the stat's unit: percentages move in points. */
const slopeIn = (pct: boolean, fmt: (v: number) => string) => (v: number) => (pct ? `${v.toFixed(1)} pts` : fmt(v)) + " a match";

interface TrendCard { key: string; label: string; tip?: string; fmt: (v: number) => string; slope: (v: number) => string; lowerIsBetter?: boolean; bench?: number; career: number | null }

export default function CareerAim() {
  const { matches } = useData();
  const { map, n } = useScope();
  const career = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const list = useMemo(() => { const f = careerEntries(matches, map).filter((s) => s.hasAim); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const all = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const visibility = list.some((s) => s.match.visibility === "ok");
  const shots = list.reduce((t, s) => t + s.shots, 0);
  const oldestFirst = useMemo(() => [...list].reverse(), [list]);
  // each metric's value per match comes with the match list; the slope over them is the engine's trend()
  const series = useMemo(() => TRENDS.map((t) => oldestFirst.map((s) => s.line.v[t.id])), [oldestFirst]);
  const cards: TrendCard[] = TRENDS.map((t) => {
    const m = metric(t.id);
    const fmt = (v: number) => fmtMetric(t.id, v);
    return { key: t.id, label: m.label, tip: tipOf(t.id), fmt, slope: slopeIn(m.unit === "pct", fmt), lowerIsBetter: m.lowerIsBetter, bench: t.bench, career: all ? all.v[t.id] : null };
  });
  const trends = useCall("trends", list.length ? [series] : null).data;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Career aim" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in careeraim">
        {!query ? (
          <Card><Empty icon={<AimIcon size={40} />} text={<NeedsDemo detail="Aim comes from recorded shots; converted logs have none." />} action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="aim-head">
              <div>
                <h1 className="section-title">Your aim over {plural(list.length, "recorded match", "recorded matches")}<Hint tip="Converted logs have no shots, so they are left out." /></h1>
                <p className="meta">{plural(shots, "gun shot")}</p>
              </div>
              <div className="toolbar__end">
                <SectionAside label="Accuracy" value={fmtMetric("accuracy", all ? all.v.accuracy : null)} color="var(--cream)" />
                <SectionAside label="Visibility" value={visibility ? "Measured" : "Not in these files"} color={visibility ? "var(--good-text)" : "var(--ink2)"} />
              </div>
            </div>
            <div className="trends">
              {cards.map((t, k) => {
                const pts = oldestFirst.map((s, i) => ({ key: s.file, value: series[k][i], label: fmtMatchDay(s.match) }));
                const tr = trends?.[k] ?? null;
                const fmt = t.fmt;
                const better = tr && (t.lowerIsBetter ? tr.slope < 0 : tr.slope > 0);
                return (
                  <Card key={t.key} title={<span data-tip={t.tip} tabIndex={0}>{t.label}</span>} aside={
                    <span className="trend-aside">
                      {!trends ? null : tr === null ? <span className="meta" data-tip="A trend needs three recorded matches with a value." tabIndex={0}>No trend yet</span> : (
                        <span className="trend-move" data-tip={`Least-squares change per match over ${tr.n} matches.`} tabIndex={0}>
                          <span className="meta">{tr.slope === 0 ? "Steady" : better ? "Improving" : "Slipping"}</span>
                          <Delta d={tr.slope} span={Math.abs(tr.slope) || 1} lowerIsBetter={t.lowerIsBetter} fmt={t.slope} />
                        </span>
                      )}
                      <b className="num cream">{t.career === null ? "–" : fmt(t.career)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={t.lowerIsBetter} />
                  </Card>
                );
              })}
            </div>
            <AimPanels query={query} label={plural(list.length, "match", "matches")} visibility={visibility} statuses={list.map((s) => s.match.visibility)} guns={career} />
          </>
        )}
      </div>
    </div>
  );
}
