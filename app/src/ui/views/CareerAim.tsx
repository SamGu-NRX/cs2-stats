// Career aim: how your aim moves across recorded matches, then every recorded shot together.
import { useMemo } from "react";
import { METRIC } from "../../stats/metrics";
import { trend } from "../../stats/trends";
import { Card } from "../components/Card";
import { TrendLine } from "../components/charts";
import { filterEntries, fmtMetric } from "../data/engine";
import { useRollups, useYourQuery } from "../data/hooks";
import { useData } from "../data/provider";
import { AimIcon } from "../icons/ui";
import { fmtDate, plural } from "../lib/format";
import { BENCH } from "../lib/verdict";
import { pageHref } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { Delta, Empty, SectionAside } from "./shared";

/** Aim metrics drawn per match; bench is a reference line on the chart. */
const TRENDS: { id: string; bench?: number }[] = [
  { id: "accuracy", bench: BENCH.acc.ref },
  { id: "firstBulletAccuracy" },
  { id: "counterStrafe" },
];

export default function CareerAim() {
  const { matches } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterEntries(matches, map).filter((s) => s.hasAim); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const scope = useMemo(() => (query ? { query } : null), [query]);
  const career = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const visibility = list.some((s) => s.match.visibility === "ok");
  const shots = list.reduce((t, s) => t + s.summary.aim.shots, 0);
  const oldestFirst = [...list].reverse();
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Career aim" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in careeraim">
        {!scope ? (
          <Card><Empty icon={<AimIcon size={40} />} text="No recorded matches yet. Aim comes from matches recorded with the capture plugin; converted logs have no shots." action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="aim-head">
              <div>
                <h1 className="section-title">Your aim over {plural(list.length, "recorded match", "recorded matches")}</h1>
                <p className="meta">{plural(shots, "shot")} with guns. Converted logs are left out because they have no shots.</p>
              </div>
              <div className="toolbar__end">
                <SectionAside label="Visibility" value={visibility ? "Measured" : "Not in these files"} color={visibility ? "var(--good-text)" : "var(--ink2)"} />
              </div>
            </div>
            <div className="trends">
              {TRENDS.map((t) => {
                const m = METRIC[t.id];
                const pts = oldestFirst.map((s) => ({ key: s.file, value: m.value(s.summary), label: fmtDate(s.match.date) }));
                // the engine's least-squares slope over match order, per match
                const tr = trend(oldestFirst.map((s, i) => ({ match: s.file, date: s.match.date, value: pts[i].value, won: null })));
                const fmt = (v: number) => fmtMetric(t.id, v);
                const better = tr && (m.lowerIsBetter ? tr.slope < 0 : tr.slope > 0);
                return (
                  <Card key={t.id} title={m.label} aside={
                    <span className="trend-aside">
                      {tr && <Delta d={tr.slope} span={Math.abs(tr.slope) || 1} lowerIsBetter={m.lowerIsBetter} fmt={fmt} title={`Change per match over ${tr.n} matches (least-squares slope)`} />}
                      <b className="num cream" data-tip={m.def}>{fmtMetric(t.id, career ? m.value(career) : null)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={m.lowerIsBetter} />
                    <p className="meta trend-note">{tr === null ? "Three recorded matches with a value are needed to show a trend." : `${tr.slope === 0 ? "Steady" : better ? "Improving" : "Slipping"}: ${fmt(Math.abs(tr.slope))} per match over ${tr.n} matches.`}</p>
                  </Card>
                );
              })}
            </div>
            <AimPanels scope={scope} label={plural(list.length, "match", "matches")} visibility={visibility} />
          </>
        )}
      </div>
    </div>
  );
}
