// Which population each number the user sees is ranked against (design/identity.md):
// - performance (the how-good rows, Firepower, Rating 3.0 percentiles, "Work on") against the pros in
//   public/baselines.json;
// - the user's style (the six style attributes, every identity metric, "plays like") against the bot
//   careers in the user's own matches, never against pros. While fewer than MIN_UNITS careers qualify
//   (a career pool that small has no quantiles), the style ranks against the bots' single matches in
//   the same matches instead, each bot's match one sample, and says so; only when even that pool is
//   under MIN_UNITS are the scores empty.
// The worker builds its compare, attributes, style and playsLike calls here from its summary, pro
// baseline and bot career sources, so the choice of population is made in one place.
import {
  attributes, BOT_CAREERS_MIN, buildPools, CAREER_MIN_ROUNDS, careerBaselines, compare, MIN_UNITS, roleOf,
  type Baselines, type CompareOptions, type Percentile, type PoolUnit, type SideKey,
} from "../stats/compare";
import type { MatchFacts } from "../stats/facts";
import { mostSimilar, STYLE, styleScores, type PackPlayer } from "../stats/identity";
import { METRIC, type Kind } from "../stats/metrics";
import { addMatch, emptySummary, type Filter, type Summary } from "../stats/rollup";
import type { Side } from "../stats/tables";
import { ATTRIBUTE_ORDER } from "../ui/data/proPack";
import type { AttributesResult, Careers, CompareResult, PackPro, PlaysLikeResult, Query, StyleResult } from "./protocol";

/** The population the user's style ranks against, and what it is made of. */
export interface BotPopulation { baselines: Baselines; careers: Careers }

/** The query narrowed to one side's rounds, or to every round for "both". */
export function sideQuery(q: Query, side: SideKey): Query {
  const { sides: _sides, ...rest } = q.filter;
  return { files: q.files, filter: side === "both" ? rest : { ...rest, sides: [side as Side] } };
}

// ---------------------------------------------------------------- bot careers

/**
 * The match-level part of a filter (maps and dates), which bot careers share with the user's query.
 * Player, side and round-level filters are the user's own and do not narrow the population.
 */
export function careerScope(f: Filter): Omit<Filter, "player"> {
  return { ...(f.maps && { maps: f.maps }), ...(f.from && { from: f.from }), ...(f.to && { to: f.to }) };
}

type Sided = Record<SideKey, Summary>;
const sided = (): Sided => ({ both: emptySummary(), CT: emptySummary(), T: emptySummary() });

/**
 * Adds one match to every bot career in it, and each bot's match on its own to `matches`. A career is
 * one bot id over the matches (the grouping ui/data/engine.ts botIds uses), summed on both sides and
 * on each.
 */
export function addCareerMatch(careers: Map<string, Sided>, matches: Sided[], f: MatchFacts, scope: Omit<Filter, "player">): void {
  for (const p of f.players) {
    if (!p.bot) continue;
    let c = careers.get(p.id);
    if (!c) careers.set(p.id, (c = sided()));
    const one = sided();
    for (const s of [c, one]) {
      addMatch(s.both, f, { ...scope, player: p.id });
      addMatch(s.CT, f, { ...scope, player: p.id, sides: ["CT"] });
      addMatch(s.T, f, { ...scope, player: p.id, sides: ["T"] });
    }
    if (one.both.m.rounds) matches.push(one);
  }
}

/** Bot careers when MIN_UNITS of them qualify, else the bots' single matches (see the header). */
export function botPopulation(careers: Sided[], matches: Sided[], built: string): BotPopulation {
  const c = careerBaselines(careers, built);
  const info = { qualified: c.careers, needed: BOT_CAREERS_MIN, minRounds: CAREER_MIN_ROUNDS, minPool: MIN_UNITS, botMatches: matches.length };
  if (c.careers >= MIN_UNITS) return { baselines: c.baselines, careers: { ...info, unit: "careers", provisional: c.provisional } };
  const units: PoolUnit[] = matches.flatMap((x) => {
    const pools = ["all", roleOf(x.both)];
    return (["both", "CT", "T"] as const).filter((side) => x[side].m.rounds > 0).map((side) => ({ pools, side, s: x[side] }));
  });
  const baselines: Baselines = { version: 1, built, source: `${matches.length} bot matches`, ...buildPools(units) };
  return { baselines, careers: { ...info, unit: "matches", provisional: true } };
}

// ---------------------------------------------------------------- the calls

/** Where the ranking calls get their inputs: the worker's cached summaries, the pro file and the bot careers of a query's matches. */
export interface Sources {
  summary(q: Query): Promise<Summary>;
  pros(): Promise<Baselines>;
  careers(q: Query): Promise<BotPopulation>;
}

/** The pool compare() reads for a summary (its role unless "all" is asked for), and that pool's size on the side. */
const poolSize = (s: Summary, b: Baselines, opt: CompareOptions) => b.n[opt.pool === "all" ? "all" : roleOf(s)]?.[opt.side ?? "both"] ?? 0;

const ofKind = (p: Record<string, Percentile>, kind: Kind) => Object.fromEntries(Object.entries(p).filter(([id]) => METRIC[id].kind === kind));

/** A pack pro's six style scores, from the pack's ATTRIBUTE_ORDER arrays. */
const proStyle = (scores: (number | null)[]) => Object.fromEntries(STYLE.map((id) => [id, scores[ATTRIBUTE_ORDER.indexOf(id)] ?? null]));

export function rankingCalls(src: Sources) {
  return {
    async compare(q: Query, opt: CompareOptions): Promise<CompareResult> {
      const [s, b] = await Promise.all([src.summary(sideQuery(q, opt.side ?? "both")), src.pros()]);
      return { p: ofKind(compare(s, b, opt), "performance"), role: roleOf(s), n: poolSize(s, b, opt) };
    },
    async attributes(q: Query, opt: CompareOptions): Promise<AttributesResult> {
      const [s, b] = await Promise.all([src.summary(sideQuery(q, opt.side ?? "both")), src.pros()]);
      return { scores: attributes(s, b, opt).filter((a) => a.kind === "performance"), role: roleOf(s), n: poolSize(s, b, opt) };
    },
    async style(q: Query, opt: CompareOptions): Promise<StyleResult> {
      const [s, c] = await Promise.all([src.summary(sideQuery(q, opt.side ?? "both")), src.careers(q)]);
      const b = c.baselines;
      return {
        scores: attributes(s, b, opt).filter((a) => a.kind === "identity"), p: ofKind(compare(s, b, opt), "identity"),
        role: roleOf(s), n: poolSize(s, b, opt), careers: c.careers,
      };
    },
    /** "Plays like": the user's T and CT style scores (against the bot careers) against each pro's (against pros), by shape. */
    async playsLike(q: Query, pros: PackPro[]): Promise<PlaysLikeResult> {
      const [t, ct, c] = await Promise.all([src.summary(sideQuery(q, "T")), src.summary(sideQuery(q, "CT")), src.careers(q)]);
      const b = c.baselines;
      const mine = { T: styleScores(attributes(t, b, { side: "T" })), CT: styleScores(attributes(ct, b, { side: "CT" })) };
      const pack: PackPlayer[] = pros.map((p) => ({ name: p.slug, sides: { both: { style: proStyle(p.both) }, CT: { style: proStyle(p.ct) }, T: { style: proStyle(p.t) } } }));
      const ranked = mostSimilar(mine, pack, "style", pros.length).map((x) => ({ slug: x.name, similarity: x.similarity }));
      return { ranked, careers: c.careers };
    },
  };
}
