// Per-match views (the Leetify parity list, PR A): the rating round by round, head to head, map zones,
// "your match" against your recent matches, opening duels in detail, man-advantage situations and
// bombsite outcomes. Each is a pure function of one match's facts (and its tables where facts keep too
// little); the worker calls them and the UI lays them out. Our definitions, over schema v1 data.
import { blindWindows } from "./blinds";
import { metricDeltas } from "./career";
import { enemyHit, hitDamage } from "./derive";
import { emptyMeasures, type MatchFacts, type Measures } from "./facts";
import { FEATURES, r3Inputs, rating3Of, RATING3_INTERCEPT, RATING3_TERMS, type Feature } from "./rating3";
import { keptRounds, rollup, type Filter, type Summary } from "./rollup";
import { roundPopulation } from "./rules";
import { swingSources, type SwingSources } from "./swing";
import type { MatchTables, Side } from "./tables";
import { FLASHED_MIN_S } from "./utility";
import { weaponClass, type WeaponClass } from "./weapons";

const playerIndex = (f: MatchFacts, id: string) => f.players.findIndex((p) => p.id === id);

// ---------------------------------------------------------------- 1. rating by round

export interface RoundRating {
  number: number;
  side: Side;
  /** null when the round has no result */
  won: boolean | null;
  /**
   * Rating 3.0 for this round alone: the intercept plus each input's coefficient times the round's
   * value of that input (eco-adjusted kills, damage and deaths, KAST and multi-kill as 0 or 100, swing in
   * points). The rating is linear, so the mean over a set of rated rounds is the rating of those rounds.
   * Null for a round Rating 3.0 does not rate (its swing or an eco value is unknown).
   */
  rating: number | null;
  /** each input's contribution, coefficient times value (RATING3_TERMS order by input); null with rating */
  terms: Record<Feature, number> | null;
  /** this round's swing by source (swing.ts swingSources); null when the round's swing is not valued */
  swing: SwingSources | null;
  /** rating minus the reference average (the caller's: the player's own average); null when either is unknown */
  vsAverage: number | null;
  /**
   * The round is one the match's Rating 3.0 is made of: rated, on a side the rating counts (rating3Of
   * rates each side only when half its rounds are rated) and in a match that passes the rating's gates.
   * The counting rounds' ratings average to the match's Rating 3.0.
   */
  counts: boolean;
}

/** One round's six Rating 3.0 inputs from its measures; null unless the round is rated. */
function roundInputs(m: Partial<Measures>): Record<Feature, number> | null {
  if (!m.ratedRounds) return null;
  return {
    kpr_eco: m.vEcoKills ?? 0, adr_eco: m.vEcoDmg ?? 0, dpr_eco: m.vEcoDeaths ?? 0, kast_eco: 100 * (m.vEcoKast ?? 0),
    mk: 100 * (m.vMultiKillRounds ?? 0), swing: 100 * (m.vSwing ?? 0),
  };
}

/** Every round the player played, in order, with its rating, its terms, its swing sources and its gap to `average`. */
export function roundRatings(f: MatchFacts, player: string, average: number | null): RoundRating[] {
  const pi = playerIndex(f, player);
  const s = rollup([f], { player });
  const counted = new Set<Side>(rating3Of(s).value === null ? [] : (["CT", "T"] as const).filter((side) => r3Inputs(s.sides[side]) !== null));
  return f.pr.filter((r) => r.pi === pi).sort((a, b) => a.ri - b.ri).map((r) => {
    const q = roundInputs(r.m);
    const terms = q ? Object.fromEntries(FEATURES.map((x) => [x, RATING3_TERMS.find((t) => t.input === x)!.coefficient * q[x]])) as Record<Feature, number> : null;
    const rating = terms ? RATING3_INTERCEPT + FEATURES.reduce((a, x) => a + terms[x], 0) : null;
    return {
      number: f.rounds[r.ri].number, side: r.side, won: r.won, rating, terms,
      swing: r.m.swingRounds ? swingSources({ ...emptyMeasures(), ...r.m }) : null,
      vsAverage: rating !== null && average !== null ? rating - average : null,
      counts: rating !== null && counted.has(r.side),
    };
  });
}

// ---------------------------------------------------------------- 2. head to head

/** Two enemies' record against each other: index 0 is a against b, index 1 b against a. */
export interface HeadToHead {
  a: string;
  b: string;
  kills: [number, number];
  /** enemy hit damage (HLTV's capped figure, derive.ts hitDamage) */
  damage: [number, number];
  /** kills by weapon class (weapons.ts weaponClass) */
  weapons: [Partial<Record<WeaponClass, number>>, Partial<Record<WeaponClass, number>>];
  /** blinds over FLASHED_MIN_S (Leetify's cut) and their seconds */
  flashes: [{ count: number; secs: number }, { count: number; secs: number }];
  /** opening kills (the round's first enemy kill) of one on the other */
  openings: [number, number];
}

/** Every pair of players on opposite teams, with what each did to the other; a pair with no interaction is all zeros. */
export function headToHead(t: MatchTables, f: MatchFacts): HeadToHead[] {
  const pairs = new Map<string, HeadToHead>();
  const slot = (x: number, y: number): [HeadToHead, 0 | 1] | null => {
    const px = f.players[x], py = f.players[y];
    if (!px || !py || px.team === null || py.team === null || px.team === py.team) return null;
    const [lo, hi] = x < y ? [x, y] : [y, x];
    const k = `${lo}:${hi}`;
    let h = pairs.get(k);
    if (!h) pairs.set(k, (h = { a: f.players[lo].id, b: f.players[hi].id, kills: [0, 0], damage: [0, 0], weapons: [{}, {}], flashes: [{ count: 0, secs: 0 }, { count: 0, secs: 0 }], openings: [0, 0] }));
    return [h, x === lo ? 0 : 1];
  };
  // every opposing pair, interactions or not
  for (let x = 0; x < f.players.length; x++) for (let y = x + 1; y < f.players.length; y++) slot(x, y);
  // only what passed between two players on the round's roster (rules.ts onRoster), as every other
  // number of theirs counts it; the rest is MatchInfo.inputs.offRoster
  const onRow = new Set(f.pr.map((r) => r.ri * 1024 + r.pi));
  const riOf = new Map(f.rounds.map((r) => [r.number, r.ri]));
  const both = (round: number, x: number | undefined, y: number | undefined) => {
    const ri = riOf.get(round);
    return ri !== undefined && x !== undefined && y !== undefined && onRow.has(ri * 1024 + x) && onRow.has(ri * 1024 + y);
  };
  for (const k of f.kills) {
    if (!k.enemy || k.killer === null || !onRow.has(k.ri * 1024 + k.killer) || !onRow.has(k.ri * 1024 + k.victim)) continue;
    const s = slot(k.killer, k.victim);
    if (!s) continue;
    const [h, i] = s;
    h.kills[i]++;
    const cls = weaponClass(k.weapon);
    h.weapons[i][cls] = (h.weapons[i][cls] ?? 0) + 1;
    if (k.opening) h.openings[i]++;
  }
  const id = new Map(f.players.map((p, i) => [p.id, i]));
  const D = t.damages;
  for (let i = 0; i < D.n; i++) {
    if (!enemyHit(t, i)) continue;
    const a = id.get(D.attacker_steamid[i]!), v = id.get(D.victim_steamid[i]);
    if (!both(D.round[i], a, v)) continue;
    const s = slot(a!, v!);
    if (s) s[0].damage[s[1]] += hitDamage(t, i);
  }
  // repeated blind rows joined, as the utility measures count them (blinds.ts)
  for (const l of blindWindows(t).values()) for (const b of l) {
    if (b.self || b.team || b.attacker === null || b.secs <= FLASHED_MIN_S) continue;
    const a = id.get(b.attacker), v = id.get(b.victim);
    if (!both(b.round, a, v)) continue;
    const s = slot(a!, v!);
    if (s) { s[0].flashes[s[1]].count++; s[0].flashes[s[1]].secs += b.secs; }
  }
  return [...pairs.values()];
}

// ---------------------------------------------------------------- 3. map zones

/** One zone (the map's place name, as the game names it) on one side: your kills and deaths there, and where they happened. */
export interface ZoneRow {
  zone: string;
  side: Side;
  kills: number;
  deaths: number;
  /** kills over deaths; null without deaths */
  kd: number | null;
  /** world [x, y] of each kill (where you stood) and each death */
  killsAt: [number, number][];
  deathsAt: [number, number][];
}

/**
 * Your kills and deaths per zone and side. A kill's zone is the kills table's place for you (a_place for a
 * kill, v_place for a death), else the place of your position sample in the same round nearest the tick,
 * within half a second (plugin files carry no kill places). A kill with neither has no zone and is left out. `zones` is the map's zone list: every
 * place a position sample of this match names, sorted.
 */
export function mapZones(t: MatchTables, player: string): { zones: string[]; rows: ZoneRow[] } {
  const P = t.positions, K = t.kills;
  const zones = new Set<string>();
  if (P) for (let i = 0; i < P.n; i++) if (P.place[i]) zones.add(P.place[i]!);
  // the player's position sample in the same round within half a second of the tick (derive.ts posAt's
  // reach); farther or in another round, the zone is unknown
  const near = t.match.tick_rate[0] / 2;
  const placeAt = (steamid: string, round: number, tick: number): string | null => {
    if (!P) return null;
    let best = -1;
    for (let i = 0; i < P.n; i++) {
      if (P.steamid[i] !== steamid || P.round[i] !== round || !P.place[i] || Math.abs(P.tick[i] - tick) > near) continue;
      if (best < 0 || Math.abs(P.tick[i] - tick) < Math.abs(P.tick[best] - tick)) best = i;
    }
    return best < 0 ? null : P.place[best];
  };
  const rows = new Map<string, ZoneRow>();
  const row = (zone: string, side: Side) => {
    const k = `${zone}|${side}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { zone, side, kills: 0, deaths: 0, kd: null, killsAt: [], deathsAt: [] }));
    return r;
  };
  for (let i = 0; i < K.n; i++) {
    if (K.is_suicide[i] || K.is_teamkill[i] || K.attacker_steamid[i] === null) continue;
    if (K.attacker_steamid[i] === player && K.a_side[i]) {
      const zone = K.a_place[i] ?? placeAt(player, K.round[i], K.tick[i]);
      if (zone) { const r = row(zone, K.a_side[i] as Side); r.kills++; if (K.a_x[i] !== null && K.a_y[i] !== null) r.killsAt.push([K.a_x[i]!, K.a_y[i]!]); }
    }
    if (K.victim_steamid[i] === player && K.v_side[i]) {
      const zone = K.v_place[i] ?? placeAt(player, K.round[i], K.tick[i]);
      if (zone) { const r = row(zone, K.v_side[i] as Side); r.deaths++; if (K.v_x[i] !== null && K.v_y[i] !== null) r.deathsAt.push([K.v_x[i]!, K.v_y[i]!]); }
    }
  }
  for (const r of rows.values()) r.kd = r.deaths ? r.kills / r.deaths : null;
  return { zones: [...zones].sort(), rows: [...rows.values()].sort((a, b) => a.zone.localeCompare(b.zone) || a.side.localeCompare(b.side)) };
}

// ---------------------------------------------------------------- 4. your match

export interface YourMatchRow {
  id: string;
  value: number | null;
  /** the metric over the reference matches, pooled (rollup), not a mean of per-match values */
  average: number | null;
  delta: number | null;
  /** performance metrics: better or worse (lowerIsBetter flips it); identity metrics: higher or lower; same when equal */
  direction: "better" | "worse" | "higher" | "lower" | "same" | null;
}

/** Every metric in this match against the same metric over the reference matches (the player's recent ones): career.ts metricDeltas, with `before` named `average`. */
export function yourMatch(match: Summary, recent: Summary): YourMatchRow[] {
  return metricDeltas(match, recent).map(({ before, ...row }) => ({ ...row, average: before }));
}

// ---------------------------------------------------------------- 5. opening duels

export interface OpeningRow {
  number: number;
  killer: string | null;
  victim: string;
  killerSide: Side | null;
  weapon: string;
  /** seconds after freeze end */
  t: number | null;
  /** the victim's death was traded */
  traded: boolean;
  /** the killer's side won the round; null when the round has no result */
  killerWon: boolean | null;
}

export interface OpeningDetail {
  rows: OpeningRow[];
  /**
   * the player's gun with the most opening kills (ties: more rounds won, then name), its rounds with a
   * known result and the wins among them; null without any
   */
  bestWeapon: { weapon: string; kills: number; decided: number; won: number } | null;
  /** rounds with a known result where the player made, or suffered, the opening kill, and how many their team won */
  afterKill: { rounds: number; won: number };
  afterDeath: { rounds: number; won: number };
}

/** The match's opening kills round by round, and the player's best opening weapon and round conversion. */
export function openingDuels(f: MatchFacts, player: string): OpeningDetail {
  const pi = playerIndex(f, player);
  const rows: OpeningRow[] = [];
  const out: OpeningDetail = { rows, bestWeapon: null, afterKill: { rounds: 0, won: 0 }, afterDeath: { rounds: 0, won: 0 } };
  const byWeapon = new Map<string, { kills: number; decided: number; won: number }>();
  for (const k of f.kills) {
    if (!k.opening) continue;
    const rf = f.rounds[k.ri];
    const killerWon = rf.winner === null || k.killerSide === null ? null : rf.winner === k.killerSide;
    rows.push({ number: rf.number, killer: k.killer === null ? null : f.players[k.killer].id, victim: f.players[k.victim].id, killerSide: k.killerSide, weapon: k.weapon, t: k.t, traded: k.traded, killerWon });
    if (k.killer === pi) {
      if (killerWon !== null) { out.afterKill.rounds++; if (killerWon) out.afterKill.won++; }
      const w = byWeapon.get(k.weapon) ?? { kills: 0, decided: 0, won: 0 };
      w.kills++;
      if (killerWon !== null) { w.decided++; if (killerWon) w.won++; }
      byWeapon.set(k.weapon, w);
    }
    if (k.victim === pi && killerWon !== null) {
      out.afterDeath.rounds++;
      if (!killerWon) out.afterDeath.won++;
    }
  }
  const best = [...byWeapon].sort((a, b) => b[1].kills - a[1].kills || b[1].won - a[1].won || a[0].localeCompare(b[0]))[0];
  out.bestWeapon = best ? { weapon: best[0], ...best[1] } : null;
  return out;
}

// ---------------------------------------------------------------- 6. situations

/** "NvM" (your side's players alive against the enemy's) -> rounds that reached it and rounds your side won. */
export type Situations = Record<string, { rounds: number; won: number }>;

/**
 * Adds one match's man-advantage situations for the rows `filter` keeps: each state your side passed
 * through (the alive counts at freeze end and after every death or disconnect of a living player, in
 * tick order, from freeze end to the round's end) counts once per round, with the round's result. A player the
 * source marks dead at freeze end (PlayerRound.aliveAtStart false) is not counted. States with a side
 * at 0 are the round's end and are left out.
 */
export function addSituations(out: Situations, f: MatchFacts, filter: Filter): void {
  for (const p of keptRounds(f, filter)) {
    const rf = f.rounds[p.ri];
    if (rf.winner === null) continue;
    // the players alive at freeze end and the live round's disconnects, as clutches read them (rules.ts roundPopulation)
    const { alive, deaths, leaves } = roundPopulation(rf, f.pr.filter((r) => r.ri === p.ri), f.kills.filter((k) => k.ri === p.ri));
    const enemy: Side = p.side === "CT" ? "T" : "CT";
    const seen = new Set<string>();
    const note = () => { if (alive[p.side].size && alive[enemy].size) seen.add(`${alive[p.side].size}v${alive[enemy].size}`); };
    note();
    // the live round's deaths and disconnects, in tick order (a death before a disconnect on one tick);
    // a player who died or left at or before freeze end was never in the counts
    const gone: { tick: number; pi: number }[] = [...deaths.map((k) => ({ tick: k.tick, pi: k.victim })), ...leaves];
    for (const e of gone.sort((x, y) => x.tick - y.tick)) if (alive.CT.delete(e.pi) || alive.T.delete(e.pi)) note();
    for (const s of seen) {
      const x = (out[s] ??= { rounds: 0, won: 0 });
      x.rounds++;
      if (rf.winner === p.side) x.won++;
    }
  }
}

// ---------------------------------------------------------------- 7. bombsites

export interface SiteOutcomes {
  /**
   * T: rounds a living teammate (or you) entered the site's zone before the plant, and those planted
   * there. Null when no round had the inputs (Bombsites.takeHold).
   */
  take: { attempts: number; success: number } | null;
  /** CT: rounds an enemy entered the site's zone before the plant, and those your side won without a plant there; null as take */
  hold: { attempts: number; success: number } | null;
  /** CT: rounds the bomb was planted at the site, and those your side won */
  retake: { attempts: number; success: number };
  /** T: rounds your side planted at the site, and those your side won */
  postPlant: { attempts: number; success: number };
}

export interface Bombsites {
  sites: Record<string, SiteOutcomes>;
  /**
   * The rounds take and hold could be read on (positions, the round's freeze end, and the map's
   * "Bombsite" place names all present), of the player's rounds with a result, and which inputs were
   * missing on the others.
   */
  takeHold: { rounds: number; known: number; missing: ("positions" | "site names" | "freeze time")[] };
}

const siteOf = (place: string | null) => (place ? /^Bombsite([A-Z])$/.exec(place)?.[1] ?? null : null);

/**
 * Site outcomes per bombsite letter over the rounds the player played. A site's zone is the map's
 * "Bombsite<letter>" place; a T player "entered" it when a living position sample of theirs names it
 * between freeze end and the plant (or the round's end without one). The plant's site is the rounds
 * table's (letter "A", "B"). Retake and post-plant come from plants alone; take and hold need the
 * positions, the freeze end and the site names, and are null when no round had them.
 */
export function bombsites(t: MatchTables, f: MatchFacts, player: string): Bombsites {
  const pi = playerIndex(f, player);
  const sites: Record<string, SiteOutcomes> = {};
  const tally = () => ({ attempts: 0, success: 0 });
  const site = (s: string) => (sites[s] ??= { take: null, hold: null, retake: tally(), postPlant: tally() });
  const P = t.positions;
  const named = !!P && P.place.some((x) => siteOf(x) !== null);
  const missing = new Set<"positions" | "site names" | "freeze time">();
  if (!P) missing.add("positions");
  else if (!named) missing.add("site names");
  const takeHold = { rounds: 0, known: 0, missing: [] as Bombsites["takeHold"]["missing"] };
  const id = new Map(f.players.map((p, i) => [p.id, i]));
  for (const me of f.pr) {
    if (me.pi !== pi) continue;
    const rf = f.rounds[me.ri];
    if (rf.winner === null) continue;
    takeHold.rounds++;
    const planted = rf.plantSite ? rf.plantSite.toUpperCase() : null;
    const won = rf.winner === me.side;
    if (planted) {
      const x = site(planted)[me.side === "T" ? "postPlant" : "retake"];
      x.attempts++;
      if (won) x.success++;
    }
    if (rf.freezeEndTick === null) missing.add("freeze time");
    if (!P || !named || rf.freezeEndTick === null) continue;
    takeHold.known++;
    // sites a living T entered before the plant
    const entered = new Set<string>();
    const until = rf.plantTick ?? rf.endTick;
    for (let i = 0; i < P.n; i++) {
      if (P.round[i] !== rf.number || !P.is_alive[i] || P.tick[i] < rf.freezeEndTick || P.tick[i] > until) continue;
      const who = id.get(P.steamid[i]);
      const r = who === undefined ? undefined : f.pr.find((x) => x.ri === me.ri && x.pi === who);
      const s = siteOf(P.place[i]);
      if (r?.side === "T" && s) entered.add(s);
    }
    for (const s of entered) {
      const o = site(s);
      if (me.side === "T") { o.take ??= tally(); o.take.attempts++; if (planted === s) o.take.success++; }
      else { o.hold ??= tally(); o.hold.attempts++; if (won && planted !== s) o.hold.success++; }
    }
  }
  // with any round read, a site no one entered has take and hold at zero rather than unknown
  if (takeHold.known) for (const o of Object.values(sites)) { o.take ??= tally(); o.hold ??= tally(); }
  takeHold.missing = [...missing];
  return { sites, takeHold };
}
