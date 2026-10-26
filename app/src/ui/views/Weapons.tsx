// Weapons: every gun you have used, best and weakest first, each with one signal: its accuracy against
// your pooled accuracy with every other gun. Kills come from every match; shots, accuracy and
// first-bullet accuracy only from recorded ones, so a cell built only from converted logs (kills and
// rounds with no shots behind them) is marked. Proficiency (familiarity and consistency rather than
// raw results) is the engine's gunProficiency.
import { useMemo } from "react";
import { HIT_GROUPS } from "../../stats/facts";
import type { GunProficiency } from "../../stats/guns";
import { weaponClass, weaponLabel } from "../../stats/weapons";
import { Num } from "../components/bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { careerEntries, fmtMetric, WEAPON_CLASS_LABEL } from "../data/engine";
import { useCall, useRollups, useYourQuery } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import type { Query, Rolled } from "../../worker/protocol";
import { WeaponIcon } from "../icons/game";
import { fmtInt, fmtPct, fmtRatio, plural, signed } from "../lib/format";
import { scoreText, toScore } from "../lib/scale";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { TIP } from "../data/tips";
import { Empty } from "./shared";

/** A gun, or your other guns pooled, needs this many shots before its accuracy is judged. */
const MIN_SHOTS = 40;
const GUN = new Set(["rifle", "sniper", "smg", "heavy", "pistol"]);

/** Kills or rounds with one gun, and how many of them come from converted logs. */
interface Split { n: number; converted: number }

interface Judged {
  weapon: string;
  cls: string;
  shots: number;
  kills: Split;
  rounds: Split;
  /** accuracy and first-bullet accuracy with this gun; accuracy only from MIN_SHOTS shots */
  acc: number | null;
  first: number | null;
  /** your accuracy with every other gun, pooled, and its shots; accuracy only from MIN_SHOTS shots */
  others: { acc: number | null; shots: number };
  /** acc minus others.acc, percentage points; null unless both sides have MIN_SHOTS shots */
  edge: number | null;
  /** headshot kills, hits on enemies and of those on the head (recorded matches only for hits) */
  hsKills: number;
  hits: number;
  headHits: number;
  /** first bullets fired and on target (the first-bullet accuracy's sample), and your other guns' first-bullet accuracy */
  firstShots: number;
  othersFirst: number | null;
  prof: GunProficiency | null;
}

const acc = (s: Rolled) => (s.aim.shots >= MIN_SHOTS ? s.v.accuracy : null);
const HEAD = HIT_GROUPS.indexOf("head");
const share = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

/**
 * Advice read off the gun's own numbers, against your other guns (main's Weapons advice, with "your
 * other guns" in place of the class average the old data model kept): accuracy, then the first bullet,
 * then how many hits land on the head.
 */
function advice(g: Judged): string {
  if (g.shots < MIN_SHOTS) return g.kills.n ? `${plural(g.kills.n, "kill")} so far; ${MIN_SHOTS} recorded shots are needed to judge your aim with it.` : "Fire it in a recorded match to see how you shoot with it.";
  const lines: string[] = [];
  if (g.edge !== null) lines.push(g.edge >= 0 ? `You hit ${g.edge.toFixed(1)} points more often than with your other guns.` : `You hit ${Math.abs(g.edge).toFixed(1)} points less often than with your other guns.`);
  if (g.first !== null && g.othersFirst !== null && g.firstShots >= 10 && g.first < g.othersFirst - 5) lines.push(`Your first bullet lands ${(g.othersFirst - g.first).toFixed(0)} points less often than with your other guns: stop moving before you fire.`);
  const head = share(g.headHits, g.hits);
  if (head !== null && g.hits >= 15 && head < 15 && g.cls !== "sniper") lines.push(`Only ${head.toFixed(0)}% of hits are on the head: keep the crosshair at head height.`);
  if (!lines.length) lines.push("In line with your other guns; keep using it.");
  return lines.join(" ");
}

/**
 * Each gun's numbers from the worker's rollups: `all` over every kept match, `recorded` over the ones
 * that are not converted logs (null when there are none), `per[i]` over gun i alone and `others[i]`
 * over every gun but i.
 */
function judge(names: string[], all: Rolled, recorded: Rolled | null, per: Rolled[], others: Rolled[], prof: GunProficiency[] | null): Judged[] {
  return names.map((w, i) => {
    const t = all.weapons[w];
    const r = recorded?.weapons[w];
    const a = acc(per[i]);
    const o = acc(others[i]);
    return {
      weapon: w, cls: weaponClass(w), shots: t.shots,
      kills: { n: t.kills, converted: t.kills - (r?.kills ?? 0) },
      rounds: { n: t.rounds, converted: t.rounds - (r?.rounds ?? 0) },
      acc: a, first: per[i].v.firstBulletAccuracy, others: { acc: o, shots: others[i].aim.shots },
      edge: a !== null && o !== null ? a - o : null, prof: prof?.find((p) => p.weapon === w) ?? null,
      hsKills: t.hsKills, hits: t.hits, headHits: t.groups[HEAD] ?? 0,
      firstShots: per[i].aim.first, othersFirst: others[i].v.firstBulletAccuracy,
    };
  });
}

/** The queries judge() reads after the base rollup: the recorded matches (when some are converted), each gun, every other gun. */
function gunQueries(query: Query, list: MatchEntry[], names: string[]): { recorded: Query | null; qs: Query[] } {
  const kept = list.filter((e) => sourceOf(e).id !== "converted").map((e) => e.file);
  const recorded = kept.length && kept.length < list.length ? { files: kept, filter: query.filter } : null;
  return {
    recorded,
    qs: [
      ...names.map((w) => ({ files: query.files, filter: { ...query.filter, weapons: [w] } })),
      ...names.map((w) => ({ files: query.files, filter: { ...query.filter, weapons: names.filter((x) => x !== w) } })),
      ...(recorded ? [recorded] : []),
    ],
  };
}

export default function Weapons() {
  const { matches } = useData();
  const { map, n } = useScope();
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const query = useYourQuery(list);
  const base = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const names = useMemo(() => Object.keys(base?.weapons ?? {}).filter((w) => GUN.has(weaponClass(w))), [base]);
  const plan = useMemo(() => (query && names.length ? gunQueries(query, list, names) : null), [query, list, names]);
  const rolled = useRollups(plan?.qs ?? null).data;
  const prof = useCall("guns", query ? [query] : null).data;
  const allConverted = list.length > 0 && list.every((e) => sourceOf(e).id === "converted");
  const guns = useMemo((): Judged[] | null => {
    // a previous filter's rollups stay in place while new ones load; wait for a matching set
    if (!base || (plan && rolled?.length !== plan.qs.length)) return null;
    if (!plan || !rolled) return [];
    const k = names.length;
    // with every match a converted log, all of a gun's kills and rounds are converted
    const recorded = plan.recorded ? rolled[2 * k] : allConverted ? null : base;
    return judge(names, base, recorded, rolled.slice(0, k), rolled.slice(k, 2 * k), prof ?? null);
  }, [base, plan, rolled, names, prof, allConverted]);
  const ranked = guns ? guns.filter((g) => g.edge !== null).sort((a, b) => b.edge! - a.edge!) : [];
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Weapons" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in weapons">
        {!list.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : !guns ? <div className="skel" style={{ height: 240 }} /> : !guns.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : (
          <>
            <div className="grid-2">
              {best && <GunHero g={best} tone="best" />}
              {worst && <GunHero g={worst} tone="worst" />}
            </div>
            <GunTable guns={guns} />
          </>
        )}
      </div>
    </div>
  );
}

const CONVERTED_TIP = "Converted logs record kills but no shots";

/** A count with its converted-log share: tagged when all of it comes from converted logs, the split in a tooltip when part does. */
function SplitCell({ s, what }: { s: Split; what: string }) {
  if (!s.n || !s.converted) return <>{s.n}</>;
  if (s.converted >= s.n) return <span className="convcell">{s.n}<span className="convtag" tabIndex={0} data-tip={`All ${s.n} ${what} come from converted logs. ${CONVERTED_TIP}.`}>converted</span></span>;
  return <span className="convcell" data-tip={`${s.converted} of ${s.n} ${what} come from converted logs. ${CONVERTED_TIP}.`}>{s.n}</span>;
}

/** "+4.2 pts": the gun's accuracy against your other guns' pooled accuracy. */
const edgeText = (edge: number) => `${signed(edge, 1)} pts`;
const edgeTip = (g: Judged) => `${fmtPct(g.acc)} with the ${weaponLabel(g.weapon)} against ${fmtPct(g.others.acc)} over ${g.others.shots} shots with your other guns`;

function GunTable({ guns }: { guns: Judged[] }) {
  return (
    <Card title="Every gun" aside={<span className="meta">Accuracy needs {MIN_SHOTS}+ recorded shots</span>} flush>
      <DataTable<Judged>
        label="Every gun"
        rows={guns}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "kills", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={13} label={undefined} />{weaponLabel(g.weapon)}<small className="faint">{WEAPON_CLASS_LABEL[g.cls]}</small></span>, width: 220 },
          { key: "kills", label: "Kills", sort: (g) => g.kills.n, render: (g) => <SplitCell s={g.kills} what="kills" /> },
          { key: "hsk", label: "HS kills", tip: TIP.hs, sort: (g) => share(g.hsKills, g.kills.n), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills.n)} /> },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", colored: true, sort: (g) => g.acc, render: (g) => <span style={{ color: g.edge === null ? undefined : scoreText(toScore(g.edge, 0, 8)) }}><Num v={fmtMetric("accuracy", g.acc)} /></span>, tip: `${metric("accuracy").def} Coloured against your accuracy with your other guns.` },
          { key: "first", label: "First bullet", sort: (g) => g.first, render: (g) => <Num v={fmtMetric("firstBulletAccuracy", g.first)} />, tip: metric("firstBulletAccuracy").def },
          { key: "head", label: "Head share", tip: "Share of your hits that landed on the head, from recorded matches", sort: (g) => share(g.headHits, g.hits), render: (g) => <Num v={fmtRatio(g.headHits, g.hits)} /> },
          { key: "rounds", label: "Rounds used", sort: (g) => g.rounds.n, render: (g) => <SplitCell s={g.rounds} what="rounds" /> },
          { key: "prof", label: "Proficiency", tip: "Familiarity (rounds used) times consistency (how steady your accuracy is from match to match), 0 to 100. Not a measure of how good your numbers are.", sort: (g) => g.prof?.proficiency ?? null, render: (g) => <span data-tip={g.prof?.evidence}><Num v={fmtInt(g.prof?.proficiency)} /></span> },
          {
            key: "edge", label: "Vs your other guns", colored: true, sort: (g) => g.edge,
            tip: `Accuracy with this gun minus your pooled accuracy with every other gun, in percentage points. Shown when both have ${MIN_SHOTS}+ recorded shots.`,
            render: (g) => (g.edge === null ? <span className="faint">–</span> : <span className="num" style={{ color: scoreText(toScore(g.edge, 0, 8)) }} data-tip={edgeTip(g)}>{edgeText(g.edge)}</span>),
          },
          { key: "advice", label: "Advice", align: "l", render: (g) => <span className="advice">{advice(g)}</span>, width: 360 },
        ]}
      />
    </Card>
  );
}

function GunHero({ g, tone }: { g: Judged; tone: "best" | "worst" }) {
  return (
    <section className={`gunhero card gunhero--${tone}`} aria-label={tone === "best" ? "Best gun" : "Weakest gun"}>
      <WeaponIcon name={g.weapon} size={64} className="gunhero__art" label={undefined} />
      <div className="gunhero__body">
        <span className="caps">{tone === "best" ? "Your best gun" : "Needs work"}</span>
        <b className="gunhero__name">{weaponLabel(g.weapon)}</b>
        <div className="gunhero__figs">
          <span><b className="num">{fmtPct(g.acc)}</b><small className="meta">accuracy</small></span>
          <span data-tip={edgeTip(g)}><b className="num" style={{ color: scoreText(toScore(g.edge ?? 0, 0, 8)) }}>{g.edge === null ? "–" : edgeText(g.edge)}</b><small className="meta">vs your other guns</small></span>
          <span><b className="num">{g.kills.n}</b><small className="meta">kills</small></span>
        </div>
        <p className="gunhero__advice">{advice(g)}</p>
      </div>
    </section>
  );
}
