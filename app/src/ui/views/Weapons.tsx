// Weapons: every gun you have used, best and weakest first, with advice read off the numbers.
// Kills come from every match; shots, accuracy and first-bullet accuracy only from recorded ones.
// Proficiency (familiarity and consistency rather than raw results) waits for its definition from
// the metrics workstream.
import { useMemo } from "react";
import { weaponLabel } from "../../stats/weapons";
import { Num } from "../components/bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { CLASS_LABEL } from "../data/aimStats";
import { filterSummaries } from "../data/engine";
import { useRawMatches } from "../data/hooks";
import { mergeTallies, weaponTallies, type WeaponTally } from "../data/interim";
import { useData } from "../data/provider";
import { WeaponIcon } from "../icons/game";
import { fmtPct, fmtRatio, plural } from "../lib/format";
import { scoreText, toScore } from "../lib/scale";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { Empty } from "./shared";

/** A gun needs this many shots before its accuracy is judged. */
const MIN_SHOTS = 40;
const GUN = new Set(["rifle", "sniper", "smg", "heavy", "pistol"]);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

interface Judged extends WeaponTally { acc: number | null; classAcc: number | null; edge: number | null }

function judge(guns: WeaponTally[]): Judged[] {
  const byClass = new Map<string, { hits: number; shots: number }>();
  for (const g of guns) { const c = byClass.get(g.cls) ?? { hits: 0, shots: 0 }; c.hits += g.hits; c.shots += g.shots; byClass.set(g.cls, c); }
  return guns.map((g) => {
    const acc = g.shots >= MIN_SHOTS ? pct(g.hits, g.shots) : null;
    const c = byClass.get(g.cls)!;
    const classAcc = pct(c.hits, c.shots);
    return { ...g, acc, classAcc, edge: acc !== null && classAcc !== null ? acc - classAcc : null };
  });
}

/** Advice from the gun's own numbers against your average for its class. */
function advice(g: Judged, all: Judged[]): string {
  if (g.shots < MIN_SHOTS) return g.kills ? `${plural(g.kills, "kill")} so far; ${MIN_SHOTS} recorded shots are needed to judge your aim with it.` : `Fire it in a recorded match to see how you shoot with it.`;
  const cls = all.filter((x) => x.cls === g.cls && x.shots >= MIN_SHOTS);
  const firstAll = cls.reduce((a, x) => ({ h: a.h + x.firstHits, n: a.n + x.firstOnTarget }), { h: 0, n: 0 });
  const first = pct(g.firstHits, g.firstOnTarget);
  const firstAvg = pct(firstAll.h, firstAll.n);
  const head = pct(g.headHits, g.hits);
  const lines: string[] = [];
  if (g.edge !== null && cls.length > 1) lines.push(g.edge >= 0 ? `You hit ${g.edge.toFixed(1)} points more often than with your other ${CLASS_LABEL[g.cls]?.toLowerCase() ?? "guns"}.` : `You hit ${Math.abs(g.edge).toFixed(1)} points less often than with your other ${CLASS_LABEL[g.cls]?.toLowerCase() ?? "guns"}.`);
  if (first !== null && firstAvg !== null && g.firstOnTarget >= 10 && first < firstAvg - 5) lines.push(`Your first bullet lands ${(firstAvg - first).toFixed(0)} points less often than your class average: stop moving before you fire.`);
  if (head !== null && g.hits >= 15 && head < 15 && g.cls !== "sniper") lines.push(`Only ${head.toFixed(0)}% of hits are on the head: keep the crosshair at head height.`);
  if (!lines.length) lines.push(`In line with your other guns; keep using it.`);
  return lines.join(" ");
}

export default function Weapons() {
  const { summaries } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterSummaries(summaries, map); return n ? f.slice(0, n) : f; }, [summaries, map, n]);
  const raws = useRawMatches(list.slice(0, 40).map((s) => s.file)).data;
  const guns = useMemo(() => {
    if (!raws) return null;
    const t = raws.reduce((acc, m) => mergeTallies(acc, weaponTallies(m)), new Map<string, WeaponTally>());
    return judge([...t.values()].filter((g) => GUN.has(g.cls)));
  }, [raws]);
  const ranked = guns ? guns.filter((g) => g.edge !== null).sort((a, b) => b.edge! - a.edge!) : [];
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Weapons" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in weapons">
        {!guns ? <div className="skel" style={{ height: 240 }} /> : !guns.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : (
          <>
            <div className="grid-2">
              {best && <GunHero g={best} tone="best" all={guns} />}
              {worst && <GunHero g={worst} tone="worst" all={guns} />}
            </div>
            <Card title="Every gun" aside={<span className="meta">Accuracy needs {MIN_SHOTS}+ recorded shots</span>} flush foot={<span>Proficiency, your familiarity and consistency with each gun, arrives with the metrics update.</span>}>
              <DataTable<Judged>
                label="Every gun"
                rows={guns}
                rowKey={(g) => g.weapon}
                defaultSort={{ key: "kills", dir: "desc" }}
                columns={[
                  { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={13} label={undefined} />{weaponLabel(g.weapon)}<small className="faint">{CLASS_LABEL[g.cls]}</small></span>, width: 220 },
                  { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
                  { key: "hsk", label: "HS kills", sort: (g) => pct(g.hsKills, g.kills), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills)} /> },
                  { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
                  { key: "acc", label: "Accuracy", colored: true, sort: (g) => g.acc, render: (g) => <span style={{ color: g.edge === null ? undefined : scoreText(toScore(g.edge, 0, 8)) }}><Num v={fmtPct(g.acc)} /></span>, tip: "Hits divided by shots; coloured against your average for the class" },
                  { key: "first", label: "First bullet", sort: (g) => pct(g.firstHits, g.firstOnTarget), render: (g) => <Num v={fmtRatio(g.firstHits, g.firstOnTarget)} /> },
                  { key: "head", label: "Head share", tip: "Share of your hits that landed on the head", sort: (g) => pct(g.headHits, g.hits), render: (g) => <Num v={fmtRatio(g.headHits, g.hits)} /> },
                  { key: "rounds", label: "Rounds used", sort: (g) => g.rounds, render: (g) => g.rounds },
                  { key: "advice", label: "Advice", align: "l", render: (g) => <span className="advice">{advice(g, guns)}</span>, width: 360 },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function GunHero({ g, tone, all }: { g: Judged; tone: "best" | "worst"; all: Judged[] }) {
  return (
    <section className={`gunhero card gunhero--${tone}`} aria-label={tone === "best" ? "Best gun" : "Weakest gun"}>
      <WeaponIcon name={g.weapon} size={64} className="gunhero__art" label={undefined} />
      <div className="gunhero__body">
        <span className="caps">{tone === "best" ? "Your best gun" : "Needs work"}</span>
        <b className="gunhero__name">{weaponLabel(g.weapon)}</b>
        <div className="gunhero__figs">
          <span><b className="num">{fmtPct(g.acc)}</b><small className="meta">accuracy</small></span>
          <span><b className="num" style={{ color: scoreText(toScore(g.edge ?? 0, 0, 8)) }}>{g.edge === null ? "–" : `${g.edge >= 0 ? "+" : "−"}${Math.abs(g.edge).toFixed(1)}`}</b><small className="meta">against your {CLASS_LABEL[g.cls]?.toLowerCase()}</small></span>
          <span><b className="num">{g.kills}</b><small className="meta">kills</small></span>
        </div>
        <p className="gunhero__advice">{advice(g, all)}</p>
      </div>
    </section>
  );
}
