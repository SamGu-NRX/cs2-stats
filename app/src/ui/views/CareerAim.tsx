// Career aim: how your aim moves across recorded matches, then every recorded shot together.
import { useMemo } from "react";
import { aimVisibility, emptyAim, mergeAim, shotsFor, sprayControl, type AimAgg } from "../../stats/aim";
import type { LightSummary } from "../../worker/protocol";
import { Card } from "../components/Card";
import { TrendLine } from "../components/charts";
import { filterSummaries } from "../data/engine";
import { emptyHitMap, hitMap, mergeHitMaps, mergeTallies, weaponTallies, type WeaponTally } from "../data/interim";
import { useRawMatches } from "../data/hooks";
import { useData } from "../data/provider";
import { AimIcon } from "../icons/ui";
import { fmtDate, fmtDeg, fmtPct, plural } from "../lib/format";
import { BENCH } from "../lib/verdict";
import { pageHref } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { AimPanels } from "./aim/AimPanels";
import { Delta, Empty, SectionAside } from "./shared";

interface Trend { id: string; label: string; def: string; value: (a: AimAgg) => number | null; fmt: (v: number) => string; bench?: number; lowerIsBetter?: boolean }

const TRENDS: Trend[] = [
  { id: "acc", label: "Accuracy", def: "Hits divided by shots, all guns.", value: (a) => { const s = shotsFor(a, "all", "all"); return s.shots ? (100 * s.hits) / s.shots : null; }, fmt: (v) => fmtPct(v), bench: BENCH.acc.ref },
  { id: "head", label: "Head accuracy", def: "Hits on the head as a share of all hits.", value: (a) => { const s = shotsFor(a, "all", "all"); return s.hits ? (100 * s.headHits) / s.hits : null; }, fmt: (v) => fmtPct(v) },
  { id: "first", label: "First-bullet accuracy", def: "First bullets of a burst with an enemy within 10° of your aim that hit.", value: (a) => { const s = shotsFor(a, "all", "all"); return s.firstOnTarget ? (100 * s.firstHits) / s.firstOnTarget : null; }, fmt: (v) => fmtPct(v) },
  { id: "control", label: "Spray control", def: "Mean distance from the target for bullets 4 and later; lower is better.", value: (a) => sprayControl(shotsFor(a, "all", "all")), fmt: (v) => fmtDeg(v, 2), lowerIsBetter: true },
  { id: "strafe", label: "Counter-strafing", def: "First bullets fired at no more than 34% of the weapon's top speed.", value: (a) => { const s = shotsFor(a, "all", "all"); return s.firstStrafeKnown ? (100 * s.firstStrafed) / s.firstStrafeKnown : null; }, fmt: (v) => fmtPct(v) },
];

export default function CareerAim() {
  const { summaries } = useData();
  const { map, n } = useFilters();
  const list: LightSummary[] = useMemo(() => { const f = filterSummaries(summaries, map).filter((s) => s.aim); return n ? f.slice(0, n) : f; }, [summaries, map, n]);
  const agg = useMemo(() => list.reduce<AimAgg | null>((a, s) => mergeAim(a ?? emptyAim(), s.aim!), null), [list]);
  const raws = useRawMatches(list.slice(0, 20).map((s) => s.file)).data;
  const hits = useMemo(() => (raws ? raws.reduce((h, m) => { const x = hitMap(m); return x ? mergeHitMaps(h, x) : h; }, emptyHitMap()) : null), [raws]);
  const guns = useMemo(() => (raws ? [...raws.reduce((t, m) => mergeTallies(t, weaponTallies(m)), new Map<string, WeaponTally>()).values()] : null), [raws]);
  const oldestFirst = [...list].reverse();
  const gate = agg ? aimVisibility(agg) : null;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Career aim" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in careeraim">
        {!agg ? (
          <Card><Empty icon={<AimIcon size={40} />} text="No recorded matches yet. Aim comes from matches recorded with the capture plugin; converted logs have no shots." action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="aim-head">
              <div>
                <h1 className="section-title">Your aim over {plural(list.length, "recorded match", "recorded matches")}</h1>
                <p className="meta">{plural(shotsFor(agg, "all", "all").shots, "shot")} with guns. Converted logs are left out because they have no shots.</p>
              </div>
              <div className="toolbar__end">
                <SectionAside label="Accuracy" value={TRENDS[0].fmt(TRENDS[0].value(agg) ?? 0)} color="var(--cream)" />
                <SectionAside label="Visibility" value={gate?.validated ? "Validated" : "Gated"} color={gate?.validated ? "var(--good-text)" : "var(--ink2)"} />
              </div>
            </div>
            <div className="trends">
              {TRENDS.map((t) => {
                const pts = oldestFirst.map((s) => ({ key: s.file, value: t.value(s.aim!), label: fmtDate(s.startUtc) }));
                const cur = t.value(agg);
                // improvement: the newer half of your recorded matches against the older half
                const vals = pts.map((p) => p.value).filter((x): x is number => x !== null);
                const half = Math.floor(vals.length / 2);
                const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
                const change = half >= 1 ? mean(vals.slice(vals.length - half)) - mean(vals.slice(0, half)) : null;
                return (
                  <Card key={t.id} title={t.label} aside={
                    <span className="trend-aside">
                      {change !== null && <Delta d={change} span={Math.abs(change) || 1} lowerIsBetter={t.lowerIsBetter} fmt={(x) => t.fmt(x)} title={`Your newer ${half} recorded matches against your older ${half}`} />}
                      <b className="num cream" data-tip={t.def}>{cur === null ? "–" : t.fmt(cur)}</b>
                    </span>
                  }>
                    <TrendLine points={pts} fmt={t.fmt} height={120} bench={t.bench} benchLabel="ref" lowerIsBetter={t.lowerIsBetter} />
                    <p className="meta trend-note">{change === null ? "Two recorded matches are needed to show a change." : `${(t.lowerIsBetter ? change < 0 : change > 0) ? "Improving" : change === 0 ? "Steady" : "Slipping"}: newer ${half} against older ${half} matches.`}</p>
                  </Card>
                );
              })}
            </div>
            <AimPanels a={agg} hits={hits} guns={guns} scope={plural(list.length, "match", "matches")} />
          </>
        )}
      </div>
    </div>
  );
}
