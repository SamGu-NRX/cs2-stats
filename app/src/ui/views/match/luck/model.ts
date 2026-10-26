// The Luck tab's data, from the engine's per-round measures and kill facts (stats/luck.ts fills both).
// Pure, so the career Luck card can reuse the phrasing and the tests can hold every rule.
//
// The engine counts run-and-gun kills, lucky headshots and low-health kills per player-round, not per
// kill. A moment names its kills only when the round's count covers every kill it could be: all of the
// round's gun kills for run-and-gun, all its gun headshots for lucky headshots, all its enemy kills for
// low health. Otherwise the row says how many and names none, rather than guessing which.
import { INPUT_COVERAGE, type Input, type KillFact, type Measures } from "../../../../stats/facts";
import { MAX_SPEED } from "../../../../stats/aim-ref";
import { CLOSE_CALL_HP, LOW_HP } from "../../../../stats/luck";
import { deathOf, killsBy, type MatchModel, type Team } from "../../../data/match";
import { DASH, plural, signed } from "../../../lib/format";

export { CLOSE_CALL_HP, LOW_HP };

// ---------------------------------------------------------------- the luck score in words

/**
 * A luck score within this many hits per 24 rounds of zero reads as even, and one at FIRM or beyond as
 * firmly one way. Ours, no evidence: no run has measured how luck scores spread across matches.
 */
export const EVEN_BAND = 0.5;
export const FIRM = 3;

export type LuckLean = "for" | "even" | "against";

export const luckLean = (score: number): LuckLean => (Math.abs(score) < EVEN_BAND ? "even" : score > 0 ? "for" : "against");

/** The luck score as a headline: "The dice were on your side". Null without a score. */
export function luckHeadline(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  const firm = Math.abs(score) >= FIRM ? "firmly " : "";
  const lean = luckLean(score);
  return lean === "even" ? "The dice were even" : lean === "for" ? `The dice were ${firm}on your side` : `The dice were ${firm}against you`;
}

/** Hits beyond the expected, one decimal with a sign: "+1.4", "−0.6", "0.0". */
export const fmtLuck = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? DASH : signed(v, 1));

/** One line for a card: "The dice were on your side: +1.4 hits per 24 rounds". Null without a score. */
export function luckSentence(score: number | null): string | null {
  const h = luckHeadline(score);
  return h === null ? null : `${h}: ${fmtLuck(score)} hits per 24 rounds`;
}

// ---------------------------------------------------------------- what the source recorded

/** The luck inputs, with the metrics each one gates. */
export const LUCK_INPUTS: { input: Input; label: string; metrics: string[] }[] = [
  { input: "spread", label: "Luck score", metrics: ["luckScore", "luckHits", "luckAgainst"] },
  { input: "killShot", label: "Run-and-gun kills", metrics: ["runAndGunKills"] },
  { input: "deathShot", label: "Run-and-gun deaths", metrics: ["runAndGunDeaths"] },
  { input: "hsShot", label: "Lucky headshots", metrics: ["luckyHeadshots"] },
  { input: "hsDeathShot", label: "Lucky headshots against you", metrics: ["luckyHeadshotDeaths"] },
  { input: "flags", label: "Flag kills", metrics: ["blindKills", "airKills", "noscopeKills", "smokeKills"] },
  { input: "deathFlags", label: "Flag deaths", metrics: ["flagDeaths"] },
];

/**
 * The inputs this player's rows lack entirely: events exist (gun kills, rounds) but the source
 * recorded the input for none of them. An input recorded for some events is not missing; its metric
 * rests on those, and its sample says how many.
 */
export function missingInputs(m: Measures): Input[] {
  return LUCK_INPUTS.map((x) => x.input).filter((i) => {
    const [known, total] = INPUT_COVERAGE[i];
    return m[total] > 0 && m[known] === 0;
  });
}

/** Why a missing input leaves its metrics out, in one line. */
export const missingLine = (i: Input) => `${LUCK_INPUTS.find((x) => x.input === i)!.label}: needs ${INPUT_COVERAGE[i][2]}, which this file does not record.`;

// ---------------------------------------------------------------- the metric list

export interface LuckRow {
  id: string;
  /** what the value rests on, from the same measures the engine divides */
  sample: (m: Measures) => string;
  /** a share's denominator: under THIN it is a thin sample */
  n?: (m: Measures) => number;
}

const of = (a: keyof Measures, b: keyof Measures): Pick<LuckRow, "sample" | "n"> => ({ sample: (m) => `${m[a]} of ${m[b]}`, n: (m) => m[b] });

/** Every luck metric in groups, each row with its sample; `inputs` are what the group's rows need. */
export const LUCK_GROUPS: { title: string; inputs: Input[]; rows: LuckRow[] }[] = [
  { title: "Luck balance", inputs: ["spread"], rows: [
    { id: "luckScore", sample: (m) => plural(m.spreadRounds, "round") },
    { id: "luckHits", sample: (m) => plural(m.luckShots, "shot") },
    { id: "luckAgainst", sample: (m) => plural(m.luckAgShots, "shot") },
  ] },
  { title: "Run and gun", inputs: ["killShot", "deathShot"], rows: [
    { id: "runAndGunKills", ...of("rgKills", "rgKnown") },
    { id: "runAndGunDeaths", ...of("rgDeaths", "rgDeathsKnown") },
  ] },
  { title: "Lucky headshots", inputs: ["hsShot", "hsDeathShot"], rows: [
    { id: "luckyHeadshots", ...of("lhKills", "lhKnown") },
    { id: "luckyHeadshotDeaths", ...of("lhDeaths", "lhDeathsKnown") },
  ] },
  { title: "Flag kills", inputs: ["flags", "deathFlags"], rows: [
    { id: "blindKills", ...of("blindKills", "flagsKnown") },
    { id: "airKills", ...of("airKills", "flagsKnown") },
    { id: "noscopeKills", ...of("noscopeKills", "flagsKnown") },
    { id: "smokeKills", ...of("smokeKills", "flagsKnown") },
    { id: "flagDeaths", ...of("flagDeaths", "flagDeathsKnown") },
  ] },
  { title: "Low health", inputs: [], rows: [
    { id: "closeCalls", sample: (m) => `${m.closeCalls} of ${plural(m.rounds, "round")}` },
    { id: "lowHpKills", sample: (m) => plural(m.lowHpKills, "kill") },
    { id: "lowHpDeaths", sample: (m) => plural(m.lowHpDeaths, "death") },
  ] },
];

/** The input a metric needs (LUCK_INPUTS), or null for one every source gives. */
export const inputOf = (id: string): Input | null => LUCK_INPUTS.find((x) => x.metrics.includes(id))?.input ?? null;

// ---------------------------------------------------------------- lucky moments

export type MomentKind = "flag" | "runGun" | "luckyHs" | "lowHp" | "closeCall";
/** Killfeed flags, by the icon pack's id. */
export type FlagId = "noscope" | "smoke" | "blind" | "inair";

export interface Moment {
  ri: number;
  /** the round's number in the match */
  round: number;
  /** your team won the round; null without a result */
  won: boolean | null;
  kind: MomentKind;
  /** the enemy's luck on you (your death), not yours */
  against: boolean;
  /** events this row stands for */
  count: number;
  /** the kills it names; empty when the round's count cannot say which kills they were */
  kills: KillFact[];
  /** kind "flag": the kill's flags */
  flags: FlagId[];
}

export const KIND_ORDER: MomentKind[] = ["flag", "runGun", "luckyHs", "lowHp", "closeCall"];

/** A kill's killfeed flags that are set; a flag the source did not record (null) is not set. */
export function flagsOf(k: Pick<KillFact, "noscope" | "smoke" | "killerBlind" | "killerInAir">): FlagId[] {
  const out: FlagId[] = [];
  if (k.noscope) out.push("noscope");
  if (k.smoke) out.push("smoke");
  if (k.killerBlind === true) out.push("blind");
  if (k.killerInAir === true) out.push("inair");
  return out;
}

const isGun = (k: KillFact) => MAX_SPEED[k.weapon] !== undefined;

/** The kills a round's count stands for, when the count covers every candidate; else none. */
const named = (count: number, candidates: KillFact[]) => (count > 0 && count === candidates.length ? candidates : []);

/** Every lucky moment of player `pi`, yours and the enemies' on you, in round order. */
export function luckMoments(v: MatchModel, pi: number = v.human): Moment[] {
  const out: Moment[] = [];
  for (const r of v.rounds) {
    const row = r.pr[pi];
    const won = r.winner === null ? null : r.winner === v.players[pi].team;
    const at = (kind: MomentKind, against: boolean, count: number, kills: KillFact[], flags: FlagId[] = []) =>
      out.push({ ri: r.ri, round: r.number, won, kind, against, count, kills, flags });
    const kills = killsBy(r, pi);
    for (const k of kills) {
      const f = flagsOf(k);
      if (f.length) at("flag", false, 1, [k], f);
    }
    const death = deathOf(r, pi);
    const enemyDeath = death && death.enemy ? death : null;
    if (enemyDeath) {
      const f = flagsOf(enemyDeath);
      if (f.length) at("flag", true, 1, [enemyDeath], f);
    }
    if (!row) continue;
    const m = row.m;
    const guns = kills.filter(isGun);
    if (m.rgKills) at("runGun", false, m.rgKills, named(m.rgKills, guns));
    if (m.lhKills) at("luckyHs", false, m.lhKills, named(m.lhKills, guns.filter((k) => k.headshot)));
    if (m.lowHpKills) at("lowHp", false, m.lowHpKills, named(m.lowHpKills, kills));
    if (m.closeCalls) at("closeCall", false, m.closeCalls, []);
    const d = enemyDeath ? [enemyDeath] : [];
    if (m.rgDeaths) at("runGun", true, m.rgDeaths, d);
    if (m.lhDeaths) at("luckyHs", true, m.lhDeaths, d);
    if (m.lowHpDeaths) at("lowHp", true, m.lowHpDeaths, d);
  }
  const rank = (x: Moment) => KIND_ORDER.indexOf(x.kind);
  return out.sort((a, b) => a.round - b.round || Number(a.against) - Number(b.against) || rank(a) - rank(b));
}

/** Events per kind, for a tally: flag kills count once per kill whatever its flags. */
export function tally(ms: Moment[]): Record<MomentKind, number> {
  const t: Record<MomentKind, number> = { flag: 0, runGun: 0, luckyHs: 0, lowHp: 0, closeCall: 0 };
  for (const x of ms) t[x.kind] += x.count;
  return t;
}

// ---------------------------------------------------------------- round by round, and the lobby

export interface RoundLuck { ri: number; round: number; won: boolean | null; halfStart: boolean; value: number | null }

/**
 * Each round's luck for player `pi`: their hits beyond the expected minus the enemies' beyond the
 * expected on them, in hits (not per 24 rounds). Null where the round's shots lack an input.
 */
export function roundLuck(v: MatchModel, pi: number = v.human): RoundLuck[] {
  return v.rounds.map((r) => {
    // a round row leaves out its measures that are 0 (PlayerRound.m)
    const m = r.pr[pi]?.m;
    const value = m?.spreadRounds ? (m.luckHits ?? 0) - (m.luckExp ?? 0) - ((m.luckAgHits ?? 0) - (m.luckAgExp ?? 0)) : null;
    return { ri: r.ri, round: r.number, won: r.winner === null ? null : r.winner === v.players[pi].team, halfStart: r.halfStart, value };
  });
}

export interface LobbyRow { pi: number; name: string; team: Team; you: boolean; score: number }

/** Every player with a luck score, luckiest first; ties keep the match's player order. */
export function lobbyLuck(v: MatchModel): LobbyRow[] {
  const rows: LobbyRow[] = [];
  for (const p of v.players) {
    const score = v.b.lines.both[p.pi]?.v.luckScore ?? null;
    if (score !== null && Number.isFinite(score)) rows.push({ pi: p.pi, name: p.name, team: p.team, you: p.isHuman, score });
  }
  return rows.sort((a, b) => b.score - a.score || a.pi - b.pi);
}
