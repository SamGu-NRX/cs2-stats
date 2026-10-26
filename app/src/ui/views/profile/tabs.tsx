// The Profile tabs' metric panels. Every metric shows as one MetricRow (components/MetricRow.tsx):
// performance metrics ranked against pros (compare), style metrics against the bots in your matches
// (style), each with the sample its value rests on. How good is gone: its rows sit in Duels and Utility.
import { useMemo, type ReactNode } from "react";
import type { Percentile as Pct, SideKey as PoolSide } from "../../../stats/compare";
import type { Measures } from "../../../stats/facts";
import type { Query, Rolled } from "../../../worker/protocol";
import { Card } from "../../components/Card";
import { MetricList, MetricRow } from "../../components/MetricRow";
import { APPROX_TIP } from "../../components/Percentile";
import { botPopulation, fmtMetric, proPoolName, proPopulation, type BotPool } from "../../data/engine";
import { useCall, useRollups } from "../../data/hooks";
import { hasMetric, metric } from "../../data/meta";
import { tipOf } from "../../data/tips";
import { fmtAdr, fmtPct, fmtRating, plural } from "../../lib/format";
import { NeedsDemo } from "../shared";
import { groupSpawns } from "./spawns";

// ---------------------------------------------------------------- ranks

/** Every metric's value and percentile for one query and side: performance against the pros, style against the bots. */
export interface Ranks {
  p: Record<string, Pct>;
  /** the bot population as one text */
  bots: string;
  /** the pro pool the performance ranks read, with its size: "454 pro riflers" */
  pros: string;
  /** the rounds the ranks were read from, for each share's "6 of 39" (Metric.of) */
  m: Measures | null;
}

export function useRanks(q: Query, side: PoolSide): Ranks | null {
  const pro = useCall("compare", [q, { side }]).data;
  const style = useCall("style", [q, { side }]).data;
  const scope = useMemo(() => {
    const { sides: _sides, ...rest } = q.filter;
    return [{ files: q.files, filter: side === "both" ? rest : { ...rest, sides: [side] } }];
  }, [q, side]);
  const m = useRollups(scope).data?.[0]?.m ?? null;
  return useMemo(() => {
    if (!pro || !style) return null;
    const bots = botPopulation(style.careers, { n: style.n, role: (style.careers.pool ?? style.role) as BotPool["role"] }).text;
    return { p: { ...style.p, ...pro.p }, bots, pros: `${pro.n} ${proPoolName(pro.role)}`, m };
  }, [pro, style, m]);
}

/**
 * A share's count, "6 of 39", from the metric's numerator and denominator measures; else its sample
 * count. `n` is the events the value rests on (the denominator, or the sample count), for thin rows.
 */
export function sampleOf(id: string, p: Pct, m: Measures | null): { text: string | null; n: number | null } {
  const meta = metric(id);
  if (meta.of && m && p.value !== null) return { text: `${m[meta.of[0]]} of ${m[meta.of[1]]}`, n: m[meta.of[1]] };
  if (meta.sample && p.n !== null) return { text: plural(p.n, meta.sample.unit.replace(/s$/, ""), meta.sample.unit), n: p.n };
  return { text: null, n: null };
}

/** One engine metric as a MetricRow; `rank` adds its rank as text (the list must be a ranked MetricList). */
export function Stat({ id, r, label, rank }: { id: string; r: Ranks; label?: string; rank?: boolean }) {
  if (!hasMetric(id)) return null;
  const meta = metric(id);
  const p = r.p[id];
  if (!p || meta.status === "unavailable") return null;
  const kind = meta.kind === "performance" ? "performance" : "style";
  const s = sampleOf(id, p, r.m);
  return (
    <MetricRow label={label ?? meta.label} value={p.value === null ? null : fmtMetric(id, p.value)} sample={s.text} n={s.n} pct={p.pct} kind={kind}
      population={kind === "performance" ? proPopulation(p.pool) : r.bots} tip={tipOf(id)} reason={p.reason} approx={meta.status === "approx"} rank={rank} />
  );
}

/** The ≈ legend in a panel's aside: the approximation explained once, through its tooltip. */
export const ApproxLegend = () => <span className="approx-legend meta" data-tip={APPROX_TIP} tabIndex={0}>≈ approximate</span>;

/**
 * A card of metric rows, each with its rank as text in the last column; rows without the metric in the
 * engine drop out. `labels` renames rows where the card's context makes the engine's label too long.
 */
export function StatCard({ title, tip, ids, r, id, labels, aside }: { title: string; tip: string; ids: string[]; r: Ranks | null; id?: string; labels?: Record<string, string>; aside?: ReactNode }) {
  const approx = ids.some((x) => hasMetric(x) && metric(x).status === "approx");
  return (
    <Card title={title} tip={tip} id={id} aside={aside || approx ? <span className="card__aside-row">{aside}{approx && <ApproxLegend />}</span> : undefined}>
      {!r ? <div className="skel" style={{ height: 36 * ids.length }} /> : <MetricList label={title} rank>{ids.map((x) => <Stat key={x} id={x} r={r} label={labels?.[x]} rank />)}</MetricList>}
    </Card>
  );
}

// ---------------------------------------------------------------- the tabs' metric groups

/** Overview's Where you rank: the five headline numbers against pros (design-target-v2 profile-overview). */
export const RANK_ROWS = ["rating3", "adr", "kast", "kpr", "accuracy"];
export const RANK_LABELS: Record<string, string> = { rating3: "Rating 3.0" };

/** Duels: opening duels, trades, clutches and AWP duels, each a card of rows. */
export const OPENING_ROWS = ["openingSuccess", "openingSwing", "openingAttempts", "openingTradedPct"];
export const TRADE_ROWS = ["tradeKillSuccess", "tradeOpps", "tradeKillsPct", "tradedDeathSuccess", "tradeableDeaths", "deathsTradedPct", "tradeDenials", "baitKillsPct", "baitAssists"];
export const CLUTCH_ROWS = ["clutchSwing", "oneVsOne", "clutches24", "lastAlive"];
export const AWP_ROWS = ["awpDuelWin", "awpSwing", "awpKillsPct", "roundsWithAwp", "sniperKillsPct"];
/** Utility: what you throw, what it does, and what you take. */
export const THROW_ROWS = ["flashesPR", "hesPR", "molotovsPR", "smokesPR", "utilSpentPR", "utilUnused"];
export const EFFECT_ROWS = ["assistsPerFlash", "flashAssistsPR", "flashSwing", "enemiesPerFlash", "blindPerFlash", "flashKillsPerFlash", "teamFlashPR", "dmgPerHe", "utilDmgPR", "fireDmgPR", "molotovEnemiesHit", "molotovDmg", "smokeSights", "smokeBlockedSecs"];
export const TAKEN_ROWS = ["grenadeDmgTaken"];
/** Economy's metric rows. */
export const ECONOMY_ROWS = ["buyDeviation", "saveConversion", "lowBuyBuys"];

/** Every metric a tab shows, by tab, for Home's Work on links. */
export const TAB_METRICS: Record<"duels" | "utility" | "economy", string[]> = {
  duels: [...OPENING_ROWS, ...TRADE_ROWS, ...CLUTCH_ROWS, ...AWP_ROWS],
  utility: [...THROW_ROWS, ...EFFECT_ROWS, ...TAKEN_ROWS],
  economy: ECONOMY_ROWS,
};

// ---------------------------------------------------------------- economy: by what you bought

const BUY_CLASSES = [["pistol", "Pistol rounds"], ["eco", "Eco"], ["half", "Half buy"], ["full", "Full buy"]] as const;

/**
 * Your numbers split by what you bought at freeze end (buySplits().own): rounds, Rating 3.0, ADR, KPR
 * and KAST per buy class. A class without rounds takes no row.
 */
export function BuySplitsCard({ q }: { q: Query }) {
  const r = useCall("buySplits", [q]);
  const rows = r.data ? BUY_CLASSES.flatMap(([k, label]) => {
    const s: Rolled | undefined = r.data!.own[k];
    return s && s.m.rounds ? [{ k, label, s }] : [];
  }) : null;
  return (
    <Card title="By what you bought" tip="Your numbers in each kind of buy round." flush>
      {!rows ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 160 }} />) : !rows.length ? <p className="meta card-pad"><NeedsDemo detail="Buy classes need every player's equipment." /></p> : (
        <table className="tbl">
          <thead><tr><th className="l">Buy</th><th>Rounds</th><th data-tip={tipOf("rating3")} tabIndex={0}>Rating 3.0</th><th data-tip={tipOf("adr")} tabIndex={0}>ADR</th><th data-tip={tipOf("kpr")} tabIndex={0}>KPR</th><th data-tip={tipOf("kast")} tabIndex={0}>KAST</th></tr></thead>
          <tbody>
            {rows.map(({ k, label, s }) => (
              <tr key={k}>
                <td className="l">{label}</td>
                <td className="num">{s.m.rounds}</td>
                <td className="num">{fmtRating(s.v.rating3 ?? null)}</td>
                <td className="num">{fmtAdr(s.v.adr ?? null)}</td>
                <td className="num">{fmtMetric("kpr", s.v.kpr ?? null)}</td>
                <td className="num">{fmtPct(s.v.kast ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- playstyle: role by spawn

/**
 * Your likeliest role by where you spawned (rolesBySpawn), one row per side, place and position with
 * the rounds summed and the role weighted by rounds (spawns.ts groupSpawns). The quiet spawns close
 * the table as one line.
 */
export function RoleBySpawnCard({ q }: { q: Query }) {
  const r = useCall("rolesBySpawn", [q]);
  const g = useMemo(() => (r.data ? groupSpawns([...r.data.T, ...r.data.CT]) : null), [r.data]);
  if (g && !g.shown.length && !g.more.groups) return null;
  return (
    <Card title="Role by spawn" tip="Your likeliest role from each spawn you start at." flush>
      {!g ? (r.error ? <p className="meta card-pad">{r.error}</p> : <div className="skel" style={{ height: 160 }} />) : (
        <table className="tbl spawns">
          <thead><tr><th className="l">Side</th><th className="l">Spawn</th><th>Rounds</th><th className="l">Role</th><th>Fit</th></tr></thead>
          <tbody>
            {g.shown.map((x) => (
              <tr key={`${x.side}|${x.label}`}>
                <td className="l"><span className={`pip pip--${x.side.toLowerCase()}`}>{x.side}</span></td>
                <td className="l">{x.label}</td>
                <td className="num">{x.rounds}</td>
                <td className="l">{x.role ?? <span className="faint">–</span>}</td>
                <td className="num">{x.fit === null ? "" : fmtPct(100 * x.fit, 0)}</td>
              </tr>
            ))}
            {g.more.groups > 0 && (
              <tr className="spawns__more"><td className="l meta" colSpan={5}>{g.shown.length ? `and ${plural(g.more.groups, "more spawn")}` : plural(g.more.groups, "spawn")}, {plural(g.more.rounds, "round")}</td></tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}
