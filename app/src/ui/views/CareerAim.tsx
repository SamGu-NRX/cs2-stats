// Career aim: how your aim moves across recorded matches, then every recorded shot together.
import { useMemo } from "react";
import { HIT_GROUPS } from "../../stats/facts";
import { isGun } from "../../stats/guns";
import type { Rolled } from "../../worker/protocol";
import { Card } from "../components/Card";
import { TrendLine } from "../components/charts";
import { careerEntries, fmtMetric } from "../data/engine";
import { useCall, useRollups, useYourQuery } from "../data/hooks";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import { AimIcon } from "../icons/ui";
import { fmtMatchDay, fmtPct, plural } from "../lib/format";
import { BENCH } from "../lib/verdict";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { Delta, Empty, NeedsDemo, SectionAside } from "./shared";

/** Aim metrics drawn per match; bench is a reference line on the chart. */
const TRENDS: { id: string; bench?: number }[] = [
  { id: "accuracy", bench: BENCH.acc.ref },
  { id: "firstBulletAccuracy" },
  { id: "counterStrafe" },
];

const HEAD = HIT_GROUPS.indexOf("head");
/**
 * Hits on the head as a share of all gun hits (main's "Head accuracy" trend). The engine has no metric
 * for it, so it is read from the rollup's per-gun hit groups, per match and over the career.
 */
function headShare(r: Rolled): number | null {
  let head = 0;
  let hits = 0;
  for (const [w, t] of Object.entries(r.weapons)) if (isGun(w)) { head += t.groups[HEAD] ?? 0; hits += t.hits; }
  return hits ? (100 * head) / hits : null;
}

interface TrendCard { key: string; label: string; def: string; fmt: (v: number) => string; lowerIsBetter?: boolean; bench?: number; career: number | null }

export default function CareerAim() {
  const { matches } = useData();
  const { map, n } = useScope();
  const list = useMemo(() => { const f = careerEntries(matches, map).filter((s) => s.hasAim); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const career = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const visibility = list.some((s) => s.match.visibility === "ok");
  const shots = list.reduce((t, s) => t + s.shots, 0);
  const oldestFirst = useMemo(() => [...list].reverse(), [list]);
  // each metric's value per match comes with the match list; the slope over them is the engine's trend()
  const perMatch = useRollups(useMemo(() => (query ? oldestFirst.map((s) => ({ files: [s.file], filter: query.filter })) : null), [query, oldestFirst])).data;
  const headSeries = useMemo(() => (perMatch?.length === oldestFirst.length ? perMatch.map(headShare) : oldestFirst.map(() => null)), [perMatch, oldestFirst]);
  const series = useMemo(() => [...TRENDS.map((t) => oldestFirst.map((s) => s.line.v[t.id])), headSeries], [oldestFirst, headSeries]);
  const cards: TrendCard[] = [
    ...TRENDS.map((t) => { const m = metric(t.id); return { key: t.id, label: m.label, def: m.def, fmt: (v: number) => fmtMetric(t.id, v), lowerIsBetter: m.lowerIsBetter, bench: t.bench, career: career ? career.v[t.id] : null }; }),
    { key: "head", label: "Head accuracy", def: "Hits on the head as a share of all hits.", fmt: (v: number) => fmtPct(v), career: career ? headShare(career) : null },
  ];
  const trends = useCall("trends", list.length ? [series] : null).data;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Career aim" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in careeraim">
        {!query ? (
          <Card><Empty icon={<AimIcon size={40} />} text={<NeedsDemo detail="Aim comes from recorded shots; converted logs have none." />} /></Card>
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
              {cards.map((t, k) => {
                const pts = oldestFirst.map((s, i) => ({ key: s.file, value: series[k][i], label: fmtMatchDay(s.match) }));
                const tr = trends?.[k] ?? null;
                const fmt = t.fmt;
                const better = tr && (t.lowerIsBetter ? tr.slope < 0 : tr.slope > 0);
                return (
                  <Card key={t.key} title={t.label} aside={
                    <span className="trend-aside">
                      {tr && <Delta d={tr.slope} span={Math.abs(tr.slope) || 1} lowerIsBetter={t.lowerIsBetter} fmt={fmt} title={`Change per match over ${tr.n} matches (least-squares slope)`} />}
                      <b className="num cream" data-tip={t.def}>{t.career === null ? "–" : fmt(t.career)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={t.lowerIsBetter} />
                    <p className="meta trend-note">{!trends ? "" : tr === null ? "Three recorded matches with a value are needed to show a trend." : `${tr.slope === 0 ? "Steady" : better ? "Improving" : "Slipping"}: ${fmt(Math.abs(tr.slope))} per match over ${tr.n} matches.`}</p>
                  </Card>
                );
              })}
            </div>
            <AimPanels query={query} label={plural(list.length, "match", "matches")} visibility={visibility} />
          </>
        )}
      </div>
    </div>
  );
}
