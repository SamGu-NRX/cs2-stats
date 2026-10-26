// Every gun you have used, judged one way: its accuracy against your pooled accuracy with every other
// gun. Shared by Weapons and Career aim. Kills and rounds come from every match; shots, accuracy and
// first-bullet accuracy only from recorded ones, so a count built only from converted logs (kills and
// rounds with no shots behind them) is marked. Proficiency (familiarity and consistency rather than
// raw results) is the engine's gunProficiency.
import { useMemo } from "react";
import { HIT_GROUPS } from "../../../stats/facts";
import type { GunProficiency } from "../../../stats/guns";
import type { Filter } from "../../../stats/rollup";
import { weaponClass, weaponLabel } from "../../../stats/weapons";
import type { Query, Rolled } from "../../../worker/protocol";
import { GameIcon } from "../../components/GameIcon";
import { useCall, useRollups, useYourQuery } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { sourceOf } from "../../data/sources";
import { WeaponIcon } from "../../icons/game";
import { fmtPct, signed } from "../../lib/format";
import { scoreText, toScore } from "../../lib/scale";

/** A gun, or your other guns pooled, needs this many shots before its accuracy is judged. */
export const MIN_SHOTS = 40;
const GUN = new Set(["rifle", "sniper", "smg", "heavy", "pistol"]);

/** Kills or rounds with one gun, and how many of them come from converted logs. */
export interface Split { n: number; converted: number }

export interface Judged {
  weapon: string;
  cls: string;
  shots: number;
  hits: number;
  /** gun hits on the head */
  head: number;
  kills: Split;
  hsKills: number;
  rounds: Split;
  /** accuracy and first-bullet accuracy with this gun; accuracy only from MIN_SHOTS shots */
  acc: number | null;
  first: number | null;
  /** the gun's own rollup: every metric narrowed to it (time to damage, time to kill) */
  own: Rolled;
  /** your accuracy with every other gun, pooled, and its shots; accuracy only from MIN_SHOTS shots */
  others: { acc: number | null; shots: number };
  /** acc minus others.acc, percentage points; null unless both sides have MIN_SHOTS shots */
  edge: number | null;
  /** first bullets fired (the first-bullet accuracy's sample), and your other guns' first-bullet accuracy */
  firstShots: number;
  othersFirst: number | null;
  prof: GunProficiency | null;
}

const acc = (s: Rolled) => (s.aim.shots >= MIN_SHOTS ? s.v.accuracy : null);
const HEAD = HIT_GROUPS.indexOf("head");
/** a as a percentage of b; null when b is 0 */
export const share = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

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
      weapon: w, cls: weaponClass(w), shots: t.shots, hits: t.hits, head: t.groups[HEAD] ?? 0,
      kills: { n: t.kills, converted: t.kills - (r?.kills ?? 0) }, hsKills: t.hsKills,
      rounds: { n: t.rounds, converted: t.rounds - (r?.rounds ?? 0) },
      acc: a, first: per[i].v.firstBulletAccuracy, own: per[i], others: { acc: o, shots: others[i].aim.shots },
      edge: a !== null && o !== null ? a - o : null, prof: prof?.find((p) => p.weapon === w) ?? null,
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

/**
 * Every gun in `list` for the recording player, narrowed by `extra` (a side): null while loading,
 * empty when no gun was used.
 */
export function useGuns(list: MatchEntry[], extra: Omit<Filter, "player"> = {}): Judged[] | null {
  const query = useYourQuery(list, extra);
  const base = useRollups(useMemo(() => (query ? [query] : null), [query])).data?.[0] ?? null;
  const names = useMemo(() => Object.keys(base?.weapons ?? {}).filter((w) => GUN.has(weaponClass(w))), [base]);
  const plan = useMemo(() => (query && names.length ? gunQueries(query, list, names) : null), [query, list, names]);
  const rolled = useRollups(plan?.qs ?? null).data;
  const prof = useCall("guns", query ? [query] : null).data;
  const allConverted = list.length > 0 && list.every((e) => sourceOf(e).id === "converted");
  return useMemo((): Judged[] | null => {
    if (!list.length) return [];
    // a previous filter's rollups stay in place while new ones load; wait for a matching set
    if (!base || (plan && rolled?.length !== plan.qs.length)) return null;
    if (!plan || !rolled) return [];
    const k = names.length;
    // with every match a converted log, all of a gun's kills and rounds are converted
    const recorded = plan.recorded ? rolled[2 * k] : allConverted ? null : base;
    return judge(names, base, recorded, rolled.slice(0, k), rolled.slice(k, 2 * k), prof ?? null);
  }, [list, base, plan, rolled, names, prof, allConverted]);
}

/** The best and the weakest gun by their edge over your other guns; the weakest only when it differs. */
export function bestAndWorst(guns: Judged[]): { best: Judged | null; worst: Judged | null } {
  const ranked = guns.filter((g) => g.edge !== null).sort((a, b) => b.edge! - a.edge!);
  return { best: ranked[0] ?? null, worst: ranked.length > 1 ? ranked[ranked.length - 1] : null };
}

/** A count with its converted-log share: tagged when all of it comes from converted logs, the split in a tooltip when part does. */
export function SplitCell({ s, what }: { s: Split; what: string }) {
  if (!s.n || !s.converted) return <>{s.n}</>;
  if (s.converted >= s.n) return <span className="convcell">{s.n}<span className="convtag" tabIndex={0} data-tip={`All ${s.n} ${what} from converted logs, which record no shots.`}>converted</span></span>;
  return <span className="convcell" tabIndex={0} data-tip={`${s.converted} of ${s.n} ${what} from converted logs, which record no shots.`}>{s.n}</span>;
}

/** A gun's advice: a short line of numbers under its name, and one sentence for its "?" tooltip. */
export interface Advice { line: string; tip: string }

/**
 * Advice read off the gun's own numbers, against your other guns (main's Weapons advice, with "your
 * other guns" in place of the class average the old data model kept). The tip is the one thing most
 * worth changing: a slow first bullet, then a low head share, then the edge itself, in one sentence
 * of 12 words or fewer; the line names the same thing in numbers.
 */
export function advice(g: Judged): Advice {
  if (g.shots < MIN_SHOTS) {
    return g.shots
      ? { line: `${g.shots} of ${MIN_SHOTS} shots`, tip: `It takes ${MIN_SHOTS} recorded shots to judge your aim with it.` }
      : { line: "No recorded shots", tip: "Fire it in a recorded match to judge your aim." };
  }
  const head = share(g.head, g.hits);
  if (g.first !== null && g.othersFirst !== null && g.firstShots >= 10 && g.first < g.othersFirst - 5) {
    const gap = (g.othersFirst - g.first).toFixed(0);
    return { line: `First bullet ${signed(-Number(gap), 0)} pts`, tip: `First bullets land ${gap} points less often, so stop before firing.` };
  }
  if (head !== null && g.hits >= 15 && head < 15 && g.cls !== "sniper") return { line: `Head share ${head.toFixed(0)}%`, tip: `Only ${head.toFixed(0)}% of hits are on the head, so aim higher.` };
  if (g.edge === null) return { line: "No other guns to compare", tip: `Your other guns need ${MIN_SHOTS} recorded shots to compare.` };
  const line = `${edgeText(g.edge)} vs other guns`;
  return { line, tip: g.edge >= 0 ? `You hit ${g.edge.toFixed(1)} points more often than with other guns.` : `You hit ${Math.abs(g.edge).toFixed(1)} points less often than with other guns.` };
}

/** The advice's "?": its one sentence on hover and focus. */
function AdviceHelp({ a }: { a: Advice }) {
  return <span className="help" data-tip={a.tip} tabIndex={0} role="note" aria-label={a.tip}>?</span>;
}

export const HEAD_TIP = "Share of your hits on the head, not of your shots.";

/** "+4.2 pts": the gun's accuracy against your other guns' pooled accuracy. */
export const edgeText = (edge: number) => `${signed(edge, 1)} pts`;
export const edgeTip = (g: Judged) => `${fmtPct(g.acc)} with the ${weaponLabel(g.weapon)}, ${fmtPct(g.others.acc)} over ${g.others.shots} shots with your other guns.`;
export const EDGE_TIP = "This gun's accuracy minus your other guns' pooled accuracy.";
export const PROF_TIP = "Familiarity times match-to-match consistency, 0 to 100, not skill.";

/**
 * A gun as the official CS2 kill icon (data/icons.ts weapons/), at a fixed height; the app's glyph
 * when the icon pack or the gun is missing. Unlabelled by default: the gun's name sits beside it.
 */
export function GunIcon({ weapon, height = 14, label }: { weapon: string; height?: number; label?: string }) {
  return <GameIcon id={weapon} width={Math.round(height * 2.9)} height={height} label={label} className="gicon--gun" fallback={<WeaponIcon name={weapon} size={height} label={label} />} />;
}

/**
 * The gun table's first cell: the gun's icon and name (and its class on Weapons, which has no class
 * rows), with the advice's line and its "?" under the name. The advice sits in this cell rather than a
 * column of its own: a twelfth column pushed the gun tables past the card's edge at 1440 px.
 */
export function GunCell({ g, cls }: { g: Judged; cls?: string }) {
  const a = advice(g);
  return (
    <span className="guncell guncell--advice">
      <GunIcon weapon={g.weapon} />
      <span className="guncell__txt">
        <span>{weaponLabel(g.weapon)}{cls ? <small className="faint">{cls}</small> : null}</span>
        <span className="guncell__advice">{a.line}<AdviceHelp a={a} /></span>
      </span>
    </span>
  );
}

/** A weapon class as a typical gun of it, for class group rows. */
const CLASS_GUN: Record<string, string> = { rifle: "ak47", sniper: "awp", smg: "mp9", heavy: "nova", pistol: "glock" };
export function ClassIcon({ cls, height = 12 }: { cls: string; height?: number }) {
  return <GunIcon weapon={CLASS_GUN[cls] ?? "ak47"} height={height} />;
}

/** The best or the weakest gun: the official icon, its accuracy, its edge over your other guns, its kills, and the advice in its "?". */
export function GunHero({ g, tone }: { g: Judged; tone: "best" | "worst" }) {
  return (
    <section className={`gunhero card gunhero--${tone}`} aria-label={tone === "best" ? "Best gun" : "Weakest gun"}>
      <span className="gunhero__art"><GunIcon weapon={g.weapon} height={52} /></span>
      <div className="gunhero__body">
        <span className="caps gunhero__cap">{tone === "best" ? "Your best gun" : "Needs work"}<AdviceHelp a={advice(g)} /></span>
        <b className="gunhero__name">{weaponLabel(g.weapon)}</b>
        <div className="gunhero__figs">
          <span><b className="num">{fmtPct(g.acc)}</b><small className="meta">accuracy</small></span>
          <span data-tip={edgeTip(g)} tabIndex={0}><b className="num" style={{ color: scoreText(toScore(g.edge ?? 0, 0, 8)) }}>{g.edge === null ? "–" : edgeText(g.edge)}</b><small className="meta">vs your other guns</small></span>
          <span><b className="num">{g.kills.n}</b><small className="meta">kills</small></span>
        </div>
      </div>
    </section>
  );
}
