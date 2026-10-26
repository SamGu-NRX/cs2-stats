// Closing: time alive, being the last of your side, clutches, being alive for the post-plant, saves.
// HLTV's "Closing" attribute shows time alive, alive for post-plant, last alive and clutches per 24
// rounds; it publishes no formulas, so each definition is ours and says so in METRICS.md.
import type { Ctx } from "./derive";
import type { ClutchFact } from "./facts";
import { detectClutches, roundPopulation } from "./rules";
import type { Side } from "./tables";

/** A convar's value as a number; null when the match row does not carry it or it is not a number. */
function convar(c: Ctx, name: string): number | null {
  const v = (JSON.parse(c.t.match.convars[0] || "{}") as Record<string, unknown>)[name];
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
}

/**
 * The match's clocks in seconds, for a clutch's time left; null where nothing in the match records
 * one. The round timer is the match's setting (mp_roundtime_defuse, else mp_roundtime, in minutes:
 * extractor demos carry it), else the length of a round of this match that ran out of time (plugin
 * files carry no convars). The bomb timer is mp_c4timer when recorded, else the plant-to-explosion
 * time of a bomb that exploded in this match. Neither falls back to a game default: the real data
 * disagrees with one (demos explode 41 s after the plant, the bot server's recordings 51 s).
 */
export function matchClocks(c: Ctx): { round: number | null; bomb: number | null } {
  const minutes = convar(c, "mp_roundtime_defuse") ?? convar(c, "mp_roundtime");
  let round = minutes === null ? null : 60 * minutes;
  let bomb = convar(c, "mp_c4timer");
  for (const rf of c.rounds) {
    if (round === null && rf.freezeEndTick !== null && (rf.reason === "time_ran_out" || rf.reason === "target_saved")) round = (rf.endTick - rf.freezeEndTick) / c.tickRate;
    const boom = c.t.rounds.explode_tick[rf.ri];
    if (bomb === null && rf.plantTick !== null && boom !== null) bomb = (boom - rf.plantTick) / c.tickRate;
  }
  return { round, bomb };
}

/** Seconds left on a clock of `total` seconds after `gone`; null when either is unknown. */
const clockLeft = (total: number | null, gone: number | null) => (total === null || gone === null ? null : Math.max(0, total - gone));

/** Fills the closing measures and returns the match's clutches, for the clutch list. */
export function closing(c: Ctx): ClutchFact[] {
  const out: ClutchFact[] = [];
  const clock = matchClocks(c);
  const withRows = new Set<number>();
  for (let i = 0; i < c.t.player_rounds.n; i++) { const ri = c.riOf(c.t.player_rounds.round[i]); if (ri !== undefined) withRows.add(ri); }
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    const list = c.kills[ri];
    const rows = c.pr[ri];
    // the players alive at freeze end, and the live round's deaths and disconnects (rules.ts roundPopulation)
    const { alive, inRound, deaths: valued, leaves } = roundPopulation(rf, rows, list);

    // The rows are the round-start roster only when the extractor read them at freeze end. A round
    // without a freeze end (recording started live) has them read one tick before the round's end, after
    // anyone who joined or left mid-round, and a round without rows takes every player with a team
    // (derive.ts buildCtx). There the alive counts are read only after deaths: being last alive and a
    // clutch both start with a death.
    const atStart = rf.freezeEndTick !== null && withRows.has(ri);

    // alive at the round's end: in the round's population, not killed by its end and not disconnected
    // (a death after the end does not count, HLTV's rule). Saves and clutch saves both read this.
    const aliveAtEnd = (pi: number) => inRound(pi) && !valued.some((k) => k.victim === pi) && !leaves.some((l) => l.pi === pi);

    // last alive: at some moment the player was the only one of their side alive (counted once)
    const live: Record<Side, Set<number>> = { CT: new Set(alive.CT), T: new Set(alive.T) };
    const last = new Set<number>();
    if (atStart) for (const s of ["CT", "T"] as const) if (live[s].size === 1) last.add([...live[s]][0]);
    const gone = [...valued.map((k) => ({ tick: k.tick, pi: k.victim, leave: 0 })), ...leaves.map((l) => ({ ...l, leave: 1 }))].sort((a, b) => a.tick - b.tick || a.leave - b.leave);
    for (const e of gone) {
      for (const s of ["CT", "T"] as const) {
        if (!live[s].delete(e.pi)) continue;
        if (live[s].size === 1) last.add([...live[s]][0]);
      }
    }

    for (const cl of detectClutches(valued, alive, rf.winner, atStart, leaves)) {
      const kills = valued.filter((k, i) => i > cl.from && k.enemy && k.killer === cl.pi).length;
      // the clutch starts at the death that left the player alone, or at freeze end for a side that
      // starts the round with one player
      const tick = cl.tick ?? rf.freezeEndTick;
      const t = tick === null || rf.freezeEndTick === null ? null : (tick - rf.freezeEndTick) / c.tickRate;
      const sincePlant = tick !== null && rf.plantTick !== null && rf.plantTick <= tick ? (tick - rf.plantTick) / c.tickRate : null;
      const afterPlant = sincePlant !== null;
      const left = afterPlant ? clockLeft(clock.bomb, sincePlant) : clockLeft(clock.round, t);
      // a save, as closing counts saves below: the round lost and the player alive at its end
      const saved = !cl.won && aliveAtEnd(cl.pi);
      out.push({ ri, pi: cl.pi, opponents: cl.opponents, won: cl.won, saved, kills, t, afterPlant, left });
      const m = c.pr[ri][cl.pi]!.m;
      const n = Math.min(5, cl.opponents) as 1 | 2 | 3 | 4 | 5;
      m[`clutch${n}`]++;
      if (cl.won) m[`clutchWon${n}`]++;
    }

    for (const p of rows) {
      if (!p) continue;
      const m = p.m;
      // the player's round ends at their death or their disconnect in the live round, whichever is first
      const death = list.find((k) => k.victim === p.pi);
      const leave = leaves.find((l) => l.pi === p.pi);
      const gone = Math.min(death?.tick ?? Infinity, leave?.tick ?? Infinity);
      if (rf.freezeEndTick !== null) {
        const until = Math.min(gone, rf.endTick);
        m.aliveSecs += Math.max(0, until - rf.freezeEndTick) / c.tickRate;
      }
      if (last.has(p.pi)) m.lastAlive = 1;
      if (rf.plantTick !== null) {
        m.postPlantRounds = 1;
        if (gone > rf.plantTick) m.aliveAtPlant = 1;
      }
      // a save: alive at the end of a lost round
      if (p.won === false && aliveAtEnd(p.pi)) m.saves = 1;
    }
  }
  return out;
}
