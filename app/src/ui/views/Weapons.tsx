// Weapons: every gun you have used, best and weakest first, with advice read off the numbers.
// Kills come from every match; shots, accuracy and first-bullet accuracy only from recorded ones.
// Proficiency (familiarity and consistency rather than raw results) is the engine's gunProficiency.
import { useMemo } from "react";
import type { GunProficiency } from "../../stats/guns";
import { weaponClass, weaponLabel } from "../../stats/weapons";
import { Num } from "../components/bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { filterEntries, fmtMetric, WEAPON_CLASS_LABEL } from "../data/engine";
import { useCall, useRollups, useYourQuery } from "../data/hooks";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import type { Rolled } from "../../worker/protocol";
import { WeaponIcon } from "../icons/game";
import { fmtInt, fmtPct, plural } from "../lib/format";
import { scoreText, toScore } from "../lib/scale";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { Empty } from "./shared";

/** A gun needs this many shots before its accuracy is judged. */
const MIN_SHOTS = 40;
const GUN = new Set(["rifle", "sniper", "smg", "heavy", "pistol"]);

interface Judged {
  weapon: string;
  cls: string;
  shots: number;
  kills: number;
  rounds: number;
  /** accuracy and first-bullet accuracy with this gun, and over every gun of its class */
  acc: number | null;
  first: number | null;
  firstShots: number;
  classAcc: number | null;
  classFirst: number | null;
  /** accuracy minus the class's, percentage points */
  edge: number | null;
  prof: GunProficiency | null;
}

const acc = (s: Rolled | undefined) => (s ? s.v.accuracy : null);
const first = (s: Rolled | undefined) => (s ? s.v.firstBulletAccuracy : null);

/** Advice from the gun's own numbers against your numbers for its class. */
function advice(g: Judged, all: Judged[]): string {
  if (g.shots < MIN_SHOTS) return g.kills ? `${plural(g.kills, "kill")} so far; ${MIN_SHOTS} recorded shots are needed to judge your aim with it.` : `Fire it in a recorded match to see how you shoot with it.`;
  const cls = all.filter((x) => x.cls === g.cls && x.shots >= MIN_SHOTS);
  const lines: string[] = [];
  if (g.edge !== null && cls.length > 1) lines.push(g.edge >= 0 ? `You hit ${g.edge.toFixed(1)} points more often than with your other ${WEAPON_CLASS_LABEL[g.cls]?.toLowerCase() ?? "guns"}.` : `You hit ${Math.abs(g.edge).toFixed(1)} points less often than with your other ${WEAPON_CLASS_LABEL[g.cls]?.toLowerCase() ?? "guns"}.`);
  if (g.first !== null && g.classFirst !== null && g.firstShots >= 10 && g.first < g.classFirst - 5) lines.push(`Your first bullet lands ${(g.classFirst - g.first).toFixed(0)} points less often than with the rest of the class: stop moving before you fire.`);
  if (!lines.length) lines.push(`In line with your other guns; keep using it.`);
  return lines.join(" ");
}

export default function Weapons() {
  const { matches } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const base = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const names = useMemo(() => Object.keys(base?.weapons ?? {}).filter((w) => GUN.has(weaponClass(w))), [base]);
  const classes = useMemo(() => [...new Set(names.map(weaponClass))], [names]);
  // one rollup per gun, then one per class over its guns
  const qs = useMemo(() => (query && names.length ? [
    ...names.map((w) => ({ files: query.files, filter: { ...query.filter, weapons: [w] } })),
    ...classes.map((c) => ({ files: query.files, filter: { ...query.filter, weapons: names.filter((w) => weaponClass(w) === c) } })),
  ] : null), [query, names, classes]);
  const per = useRollups(qs).data;
  const prof = useCall("guns", query ? [query] : null).data;
  const guns = useMemo((): Judged[] | null => {
    // a previous filter's rollups stay in place while new ones load; wait for a matching set
    if (!base || (names.length && per?.length !== names.length + classes.length)) return null;
    return names.map((w, i) => {
      const t = base.weapons[w];
      const cls = weaponClass(w);
      const cs = per![names.length + classes.indexOf(cls)];
      const a = t.shots >= MIN_SHOTS ? acc(per![i]) : null;
      const classAcc = acc(cs);
      return {
        weapon: w, cls, shots: t.shots, kills: t.kills, rounds: t.rounds, acc: a, first: first(per![i]), firstShots: per![i].aim.first,
        classAcc, classFirst: first(cs), edge: a !== null && classAcc !== null ? a - classAcc : null, prof: prof?.find((p) => p.weapon === w) ?? null,
      };
    });
  }, [base, names, classes, per, prof]);
  const ranked = guns ? guns.filter((g) => g.edge !== null).sort((a, b) => b.edge! - a.edge!) : [];
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Weapons" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in weapons">
        {!list.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : !guns ? <div className="skel" style={{ height: 240 }} /> : !guns.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : (
          <>
            <div className="grid-2">
              {best && <GunHero g={best} tone="best" all={guns} />}
              {worst && <GunHero g={worst} tone="worst" all={guns} />}
            </div>
            <Card title="Every gun" aside={<span className="meta">Accuracy needs {MIN_SHOTS}+ recorded shots</span>} flush>
              <DataTable<Judged>
                label="Every gun"
                rows={guns}
                rowKey={(g) => g.weapon}
                defaultSort={{ key: "kills", dir: "desc" }}
                columns={[
                  { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={13} label={undefined} />{weaponLabel(g.weapon)}<small className="faint">{WEAPON_CLASS_LABEL[g.cls]}</small></span>, width: 220 },
                  { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
                  { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
                  { key: "acc", label: "Accuracy", colored: true, sort: (g) => g.acc, render: (g) => <span style={{ color: g.edge === null ? undefined : scoreText(toScore(g.edge, 0, 8)) }}><Num v={fmtMetric("accuracy", g.acc)} /></span>, tip: `${metric("accuracy").def} Coloured against your accuracy with the whole class.` },
                  { key: "first", label: "First bullet", sort: (g) => g.first, render: (g) => <Num v={fmtMetric("firstBulletAccuracy", g.first)} />, tip: metric("firstBulletAccuracy").def },
                  { key: "rounds", label: "Rounds used", sort: (g) => g.rounds, render: (g) => g.rounds },
                  { key: "prof", label: "Proficiency", tip: "Familiarity (rounds used) times consistency (how steady your accuracy is from match to match), 0 to 100. Not a measure of how good your numbers are.", sort: (g) => g.prof?.proficiency ?? null, render: (g) => <span data-tip={g.prof?.evidence}><Num v={fmtInt(g.prof?.proficiency)} /></span> },
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
          <span><b className="num" style={{ color: scoreText(toScore(g.edge ?? 0, 0, 8)) }}>{g.edge === null ? "–" : `${g.edge >= 0 ? "+" : "−"}${Math.abs(g.edge).toFixed(1)}`}</b><small className="meta">against your {WEAPON_CLASS_LABEL[g.cls]?.toLowerCase()}</small></span>
          <span><b className="num">{g.kills}</b><small className="meta">kills</small></span>
        </div>
        <p className="gunhero__advice">{advice(g, all)}</p>
      </div>
    </section>
  );
}
