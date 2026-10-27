// Leetify's numbers as Leetify's own app shows them, each beside the closest number this app computes,
// with what each one measures and where the two definitions part.
//
// Leetify's developer guidelines (section 5) ask apps not to rename, rescale or recompute Leetify's
// metrics. So every Leetify value here is the API's own number under Leetify's own label, formatted the
// way Leetify shows it: 0-100 ratings as plain numbers ("Aim Rating 60", no %), match-level Leetify
// Ratings x100 with a sign (0.1232 shows as +12.32, as Leetify's match pages do), shares as percentages.
// Where Leetify's app has no published label for an API field, the label is the field's name in words.
//
// The definition notes come from the research inventory of Leetify's metrics against this app's
// (Leetify's glossary, its blog posts and its in-app hints), kept outside the repository.
import type { Measure, Measures } from "../../../stats/facts";
import type { Values } from "../../../worker/protocol";
import { fmtMetric } from "../engine";
import { DASH, fixed, fmtInt, signed } from "../../lib/format";
import type { LeetifyPlayerStats, LeetifyProfile, MatchStatKey, ProfileRatingKey, ProfileStatKey } from "./api";

const ok = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Leetify's formats. */
export const lf = {
  /** a 0-100 rating: "60" */
  score: (v: number | null) => (ok(v) ? String(Math.round(v)) : DASH),
  /** a Leetify Rating already on the display scale (profile ranks.leetify): "+2.12" */
  rating: (v: number | null) => (ok(v) ? signed(v, 2) : DASH),
  /** a Leetify Rating as a fraction (match and side ratings): 0.1232 → "+12.32" */
  ratingX100: (v: number | null) => (ok(v) ? signed(100 * v, 2) : DASH),
  /** a share on 0-100: "34.4%" */
  pct: (v: number | null) => (ok(v) ? `${fixed(v, 1)}%` : DASH),
  /** a share on 0-1: 0.344 → "34.4%" */
  share: (v: number | null) => (ok(v) ? `${fixed(100 * v, 1)}%` : DASH),
  ms: (v: number | null) => (ok(v) ? `${Math.round(v)}ms` : DASH),
  /** seconds sent where Leetify shows milliseconds (a match's reaction_time) */
  secsAsMs: (v: number | null) => (ok(v) ? `${Math.round(1000 * v)}ms` : DASH),
  deg: (v: number | null) => (ok(v) ? `${fixed(v, 2)}°` : DASH),
  secs: (v: number | null) => (ok(v) ? `${fixed(v, 2)}s` : DASH),
  dec: (v: number | null) => (ok(v) ? fixed(v, 2) : DASH),
  dmg: (v: number | null) => (ok(v) ? fixed(v, 1) : DASH),
  money: (v: number | null) => (ok(v) ? `$${Math.round(v)}` : DASH),
  count: (v: number | null) => fmtInt(v),
};

/** Our side of a row: a metric by id, or a count from the measures. */
export type Ours =
  | { metric: string; side?: "t" | "ct" }
  | { measure: Measure; side?: "t" | "ct" };

/** What our numbers are read from, per side. */
export interface OursSource { both: { v: Values; m: Measures }; t: { v: Values; m: Measures } | null; ct: { v: Values; m: Measures } | null }

/** Swing-family metrics read as signed percentages, as Profile shows round swing. */
const SIGNED = new Set(["swing", "openingSwing", "clutchSwing"]);

/** Our value for a row, formatted; null when the side it needs is not loaded. */
export function oursText(o: Ours, src: OursSource): { value: number | null; text: string } | null {
  const s = o.side ? src[o.side] : src.both;
  if (!s) return null;
  if ("measure" in o) return { value: s.m[o.measure], text: fmtInt(s.m[o.measure]) };
  const v = s.v[o.metric] ?? null;
  return { value: v, text: v === null ? DASH : SIGNED.has(o.metric) ? `${signed(v, 2)}%` : fmtMetric(o.metric, v) };
}

export interface Row<S> {
  key: string;
  /** Leetify's label */
  label: string;
  /** what Leetify's number measures, in one sentence */
  what: string;
  value: (s: S) => number | null;
  fmt: (v: number | null) => string;
  /** our closest number, with its label; null when we have none */
  ours: (Ours & { label: string }) | null;
  /**
   * "same" when both count the same thing (formats may differ), "differs" when the definitions part,
   * "none" when we have nothing to set beside it
   */
  match: "same" | "differs" | "none";
  /** how the two compare, or why we have none */
  note: string;
}

export interface Group<S> { title: string; rows: Row<S>[] }

// ---------------------------------------------------------------- shared definitions

const SPOTTED_NOTE = "Leetify's first sight is the game's spotted flag; ours is the enemy on your screen by the map's line of sight.";

const AIM = {
  spotted: { label: "Accuracy (Enemy Spotted)", what: "Hits divided by shots, counting shots fired while you had an enemy spotted.", ours: { metric: "sightAccuracy", label: "Accuracy at visible enemies" }, match: "differs" as const, note: "Leetify counts shots while the game marked an enemy as spotted; we count shots while an enemy was in line of sight near your crosshair." },
  head: { label: "Headshot Accuracy", what: "Shots that hit an enemy's head, divided by all shots that hit an enemy. AWP shots are left out.", ours: { metric: "headAccuracy", label: "Head accuracy" }, match: "differs" as const, note: "Leetify leaves AWP shots out; we count every gun." },
  spray: { label: "Spray Accuracy", what: "Hits divided by shots within sprays of 3 or more shots fired with an enemy spotted.", ours: { metric: "sprayAccuracy", label: "Spray accuracy" }, match: "differs" as const, note: "Leetify counts every shot of a 3+ shot spray; we count bullets 4 and later, at a visible enemy." },
  strafe: { label: "Proper Counter-Strafing", what: "Shots fired under 34% of the weapon's top speed. Rifles, Deagle and snipers; crouching shots left out.", ours: { metric: "counterStrafe", label: "Counter-strafed first shots" }, match: "differs" as const, note: "Leetify judges every rifle, Deagle and sniper shot; we judge first bullets only, at the same speed rule." },
  preaim: { label: "Crosshair Placement", what: "Median angle your aim moved between first seeing an enemy and your first hit on him.", ours: { metric: "crosshairMoved", label: "Degrees moved to damage" }, match: "differs" as const, note: `Both are the median angle moved from first sight to the first hit. ${SPOTTED_NOTE}` },
  ttd: { label: "Time to Damage", what: "Median time from first seeing an enemy to first damaging him; times of 1 s or more are left out.", ours: { metric: "timeToDamage", label: "Time to damage" }, match: "differs" as const, note: `Both take the median and drop times of 1 s or more. ${SPOTTED_NOTE}` },
};

const UTIL = {
  flashKillShare: { label: "Flashbangs Leading to Kills", what: "Share of your flashbangs whose blinded enemy was then killed by your team. Blinds under 1.1 s and teammates left out.", ours: { metric: "flashKillsPerFlash", label: "Flash-to-kills per flash" }, match: "differs" as const, note: "Leetify counts flashbangs that led to a kill, as a share of flashbangs; we count kills of enemies still blind from your flashbangs, per flashbang, so one flashbang that sets up two kills counts twice." },
  enemiesPerFlash: { label: "Enemies Flashed per Flashbang", what: "Enemies blinded for more than 1.1 s, per flashbang thrown.", ours: { metric: "enemiesPerFlash", label: "Enemies flashed per flash" }, match: "same" as const, note: "Same definition, with the same 1.1 s cut." },
  blind: { label: "Flash Blind Duration per Flashed Enemy", what: "For each flashbang, how long its longest-blinded enemy stayed blind, averaged over flashbangs that blinded someone.", ours: { metric: "blindPerFlash", label: "Enemy blind time per flash" }, match: "differs" as const, note: "Leetify takes each flashbang's longest blind, over flashbangs that blinded someone; we add up every enemy's blind time, over every flashbang." },
  he: { label: "Damage to Enemies per HE", what: "HE grenade damage to enemies, divided by HE grenades thrown.", ours: { metric: "dmgPerHe", label: "Damage per HE thrown" }, match: "same" as const, note: "Same definition." },
  unused: { label: "Unused Utility on Death", what: "Value of the grenades you still held when you died, averaged over your deaths.", ours: { metric: "utilUnused", label: "Unused utility on death" }, match: "differs" as const, note: "Same rate, but we only see grenades you held at freeze end; ones picked up later are missed." },
};

const TRADE = {
  kill: { label: "Trade Kill Success", what: "Trade attempts that ended with you killing the killer.", ours: { metric: "tradeAttemptSuccess", label: "Trade attempt success" }, match: "differs" as const, note: "Both divide trades by attempts. Our trade window is 5.4 s; Leetify does not publish its window." },
  death: { label: "Traded Deaths Success", what: "Your deaths a teammate tried to trade that ended with the trade.", ours: { metric: "tradedDeathSuccess", label: "Traded death success" }, match: "differs" as const, note: "Leetify divides by deaths a teammate tried to trade; we divide by deaths a teammate within 1,000 units could have traded." },
};

const SWING_NOTE = "Both credit kills by how much they change the round's win chance. Leetify splits a kill's credit 35% killer, 30% damage dealers, 15% flash assist, 20% the traded teammate, and adjusts for economy; our round swing uses its own credit rules and reads in % win chance per round, so the scales differ.";

// ---------------------------------------------------------------- the profile

const rating = (k: ProfileRatingKey) => (p: LeetifyProfile) => p.rating[k];
const stat = (k: ProfileStatKey) => (p: LeetifyProfile) => p.stats[k];

/** Leetify's three 0-100 ratings, the headline of the profile card; we compute none of them. */
export const PROFILE_SCORES: { key: ProfileRatingKey; label: string; what: string }[] = [
  { key: "aim", label: "Aim Rating", what: "A 0-100 score from Leetify's aim stats against the average player; 50 is exactly average. We compute no Aim Rating: Leetify's weights are unpublished, so its inputs are compared below instead." },
  { key: "utility", label: "Utility Rating", what: "A 0-100 score for the quantity and quality of the utility you throw; 50 is exactly average. We compute none: Leetify's quality weights are unpublished." },
  { key: "positioning", label: "Positioning Rating", what: "A 0-100 score; Leetify publishes no formula for it, so we have nothing to set beside it." },
];

export const PROFILE_GROUPS: Group<LeetifyProfile>[] = [
  {
    title: "Impact",
    rows: [
      { key: "leetify", label: "Leetify Rating", what: "Leetify's win-rate impact rating over its recent matches; +0.00 is exactly average.", value: (p) => p.leetifyRating, fmt: lf.rating, ours: { metric: "swing", label: "Round swing" }, match: "differs", note: SWING_NOTE },
      { key: "ct_leetify", label: "Leetify Rating (CT Side)", what: "Leetify Rating on the CT side.", value: rating("ct_leetify"), fmt: lf.ratingX100, ours: { metric: "swing", side: "ct", label: "Round swing, CT" }, match: "differs", note: SWING_NOTE },
      { key: "t_leetify", label: "Leetify Rating (T Side)", what: "Leetify Rating on the T side.", value: rating("t_leetify"), fmt: lf.ratingX100, ours: { metric: "swing", side: "t", label: "Round swing, T" }, match: "differs", note: SWING_NOTE },
      { key: "opening", label: "Opening Rating", what: "Your average Leetify Rating in opening duels.", value: rating("opening"), fmt: lf.ratingX100, ours: { metric: "openingSwing", label: "Opening swing" }, match: "differs", note: "Ours is the swing from first kills and first deaths, per round; Leetify averages its rating over opening duels." },
      { key: "clutch", label: "Clutch Rating", what: "Leetify Rating earned in clutches; Leetify publishes no formula.", value: rating("clutch"), fmt: lf.ratingX100, ours: { metric: "clutchSwing", label: "Clutch swing" }, match: "differs", note: "Ours is the swing from your kills and deaths after you became your side's last player alive, per round; Leetify's formula is unpublished." },
    ],
  },
  {
    title: "Aim",
    rows: [
      { key: "spotted", ...AIM.spotted, value: stat("accuracy_enemy_spotted"), fmt: lf.pct },
      { key: "head", ...AIM.head, value: stat("accuracy_head"), fmt: lf.pct },
      { key: "spray", ...AIM.spray, value: stat("spray_accuracy"), fmt: lf.pct },
      { key: "strafe", ...AIM.strafe, value: stat("counter_strafing_good_shots_ratio"), fmt: lf.pct },
      { key: "preaim", ...AIM.preaim, value: stat("preaim"), fmt: lf.deg },
      { key: "ttd", ...AIM.ttd, value: stat("reaction_time_ms"), fmt: lf.ms },
    ],
  },
  {
    title: "Utility",
    rows: [
      { key: "flashkill", ...UTIL.flashKillShare, value: stat("flashbang_leading_to_kill"), fmt: lf.pct },
      { key: "enemies", ...UTIL.enemiesPerFlash, value: stat("flashbang_hit_foe_per_flashbang"), fmt: lf.dec },
      { key: "friends", label: "Friends Flashed per Flashbang", what: "Teammates, and you, blinded for more than 1.1 s, per flashbang thrown.", value: stat("flashbang_hit_friend_per_flashbang"), fmt: lf.dec, ours: { metric: "teamFlashPR", label: "Teammates flashed per round" }, match: "differs", note: "Leetify counts per flashbang and includes you; we count per round and leave you out." },
      { key: "blind", ...UTIL.blind, value: stat("flashbang_hit_foe_avg_duration"), fmt: lf.secs },
      { key: "he", ...UTIL.he, value: stat("he_foes_damage_avg"), fmt: lf.dmg },
      { key: "heteam", label: "Damage to Teammates per HE", what: "HE grenade damage to teammates, divided by HE grenades thrown.", value: stat("he_friends_damage_avg"), fmt: lf.dmg, ours: null, match: "none", note: "We do not compute team damage per HE." },
      { key: "unused", ...UTIL.unused, value: stat("utility_on_death_avg"), fmt: lf.money },
    ],
  },
  {
    title: "Duels and trades",
    rows: [
      { key: "ctopen", label: "CT Opening Duel Success", what: "Share of the CT side's first duels of a round that you won.", value: stat("ct_opening_duel_success_percentage"), fmt: lf.pct, ours: { metric: "openingSuccess", side: "ct", label: "Opening duel success, CT" }, match: "same", note: "Same definition: opening duels won, of opening duels you took part in." },
      { key: "topen", label: "T Opening Duel Success", what: "Share of the T side's first duels of a round that you won.", value: stat("t_opening_duel_success_percentage"), fmt: lf.pct, ours: { metric: "openingSuccess", side: "t", label: "Opening duel success, T" }, match: "same", note: "Same definition: opening duels won, of opening duels you took part in." },
      { key: "tradeopp", label: "Trade Kill Opportunities per Round", what: "Chances you had to trade a teammate, per round.", value: stat("trade_kill_opportunities_per_round"), fmt: lf.dec, ours: { metric: "tradeOpps", label: "Trade opportunities per round" }, match: "differs", note: "Our opportunity is a teammate dying within 1,000 units of you while you are alive; Leetify does not publish its radius or window." },
      { key: "tradekill", ...TRADE.kill, value: stat("trade_kills_success_percentage"), fmt: lf.pct },
      { key: "tradedeath", ...TRADE.death, value: stat("traded_deaths_success_percentage"), fmt: lf.pct },
    ],
  },
];

// ---------------------------------------------------------------- one match

const m = (k: MatchStatKey) => (s: LeetifyPlayerStats) => s[k];

export const MATCH_GROUPS: Group<LeetifyPlayerStats>[] = [
  {
    title: "Impact",
    rows: [
      { key: "lr", label: "Leetify Rating", what: "Leetify's win-rate impact rating for this match; +0.00 is exactly average.", value: m("leetify_rating"), fmt: lf.ratingX100, ours: { metric: "swing", label: "Round swing" }, match: "differs", note: SWING_NOTE },
      { key: "lrct", label: "Leetify Rating (CT Side)", what: "Leetify Rating on the CT side of this match.", value: m("ct_leetify_rating"), fmt: lf.ratingX100, ours: { metric: "swing", side: "ct", label: "Round swing, CT" }, match: "differs", note: SWING_NOTE },
      { key: "lrt", label: "Leetify Rating (T Side)", what: "Leetify Rating on the T side of this match.", value: m("t_leetify_rating"), fmt: lf.ratingX100, ours: { metric: "swing", side: "t", label: "Round swing, T" }, match: "differs", note: SWING_NOTE },
    ],
  },
  {
    title: "Scoreboard",
    rows: [
      { key: "k", label: "Kills", what: "Enemies you killed.", value: m("total_kills"), fmt: lf.count, ours: { measure: "kills", label: "Kills" }, match: "same", note: "Both count enemy kills. A gap means one side saw a round the other did not." },
      { key: "d", label: "Deaths", what: "Times you died.", value: m("total_deaths"), fmt: lf.count, ours: { measure: "deaths", label: "Deaths" }, match: "same", note: "Both count your deaths." },
      { key: "a", label: "Assists", what: "The game's assists.", value: m("total_assists"), fmt: lf.count, ours: { measure: "assists", label: "Assists" }, match: "same", note: "Both read the game's assister on each kill." },
      { key: "adr", label: "ADR", what: "Damage to enemies per round (the API's dpr field).", value: m("dpr"), fmt: lf.dmg, ours: { metric: "adr", label: "ADR" }, match: "differs", note: "Ours caps each hit at the victim's remaining health, as HLTV does; Leetify does not publish whether it caps." },
      { key: "hsk", label: "Headshot Kills", what: "Kills with a headshot.", value: m("total_hs_kills"), fmt: lf.count, ours: { measure: "hsKills", label: "Headshot kills" }, match: "same", note: "Both count kills the game marks as headshots." },
    ],
  },
  {
    title: "Aim",
    rows: [
      { key: "acc", label: "Accuracy (All Shots)", what: "Shots that hit an enemy, divided by all shots.", value: m("accuracy"), fmt: lf.share, ours: { metric: "accuracy", label: "Accuracy" }, match: "same", note: "Both divide hits on enemies by every gun shot." },
      { key: "spotted", ...AIM.spotted, value: m("accuracy_enemy_spotted"), fmt: lf.share },
      { key: "head", ...AIM.head, value: m("accuracy_head"), fmt: lf.share },
      { key: "spray", ...AIM.spray, value: m("spray_accuracy"), fmt: lf.share },
      { key: "strafe", ...AIM.strafe, value: m("counter_strafing_shots_good_ratio"), fmt: lf.share },
      { key: "preaim", ...AIM.preaim, value: m("preaim"), fmt: lf.deg },
      { key: "ttd", ...AIM.ttd, value: m("reaction_time"), fmt: lf.secsAsMs },
    ],
  },
  {
    title: "Utility",
    rows: [
      { key: "flashes", label: "Flashbangs Thrown", what: "Flashbangs you threw.", value: m("flashbang_thrown"), fmt: lf.count, ours: { measure: "flashes", label: "Flashbangs thrown" }, match: "same", note: "Both count flashbangs thrown." },
      { key: "foes", label: "Enemies Flashed", what: "Enemies your flashbangs blinded.", value: m("flashbang_hit_foe"), fmt: lf.count, ours: { measure: "enemiesFlashed", label: "Enemies flashed" }, match: "differs", note: "Ours counts blinds over 1.1 s only; Leetify does not say whether this count uses its 1.1 s cut." },
      { key: "flk", label: "Flashbangs Leading to Kills", what: "Flashbangs whose blinded enemy your team then killed.", value: m("flashbang_leading_to_kill"), fmt: lf.count, ours: { measure: "flashKills", label: "Flash-to-kills" }, match: "differs", note: "Leetify counts flashbangs; we count the kills, so one flashbang that sets up two kills counts twice here." },
      { key: "blind", ...UTIL.blind, value: m("flashbang_hit_foe_avg_duration"), fmt: lf.secs },
      { key: "he", ...UTIL.he, value: m("he_foes_damage_avg"), fmt: lf.dmg },
      { key: "unused", ...UTIL.unused, value: m("utility_on_death_avg"), fmt: lf.money },
    ],
  },
  {
    title: "Trades",
    rows: [
      { key: "topp", label: "Trade Kill Opportunities", what: "Chances you had to trade a teammate.", value: m("trade_kill_opportunities"), fmt: lf.count, ours: { measure: "tradeOpps", label: "Trade opportunities" }, match: "differs", note: "Our opportunity is a teammate dying within 1,000 units of you while you are alive; Leetify does not publish its radius or window." },
      { key: "tatt", label: "Trade Kill Attempts", what: "Opportunities where you tried to trade.", value: m("trade_kill_attempts"), fmt: lf.count, ours: { measure: "tradeAttempts", label: "Trade attempts" }, match: "differs", note: "Our attempt is hitting the killer within 5.4 s; Leetify does not publish its rule." },
      { key: "tkill", ...TRADE.kill, value: m("trade_kills_success_percentage"), fmt: lf.share },
      { key: "tdeath", ...TRADE.death, value: m("traded_deaths_success_percentage"), fmt: lf.share },
    ],
  },
];

/** "Matchmaking", "FACEIT", "Renown": a data source's name for the matches list. Unknown ones keep Leetify's word. */
export function sourceName(s: string): string {
  const known: Record<string, string> = { matchmaking: "Matchmaking", matchmaking_competitive: "Competitive", matchmaking_wingman: "Wingman", faceit: "FACEIT", renown: "Renown", esplay: "Esplay", hltv: "HLTV", manual_rush: "Manual upload" };
  return known[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
