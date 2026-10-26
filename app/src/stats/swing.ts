// Round swing, HLTV's "Swing": each event's change in the round win probability (winprob.ts, from the
// source the match was derived with), credited to players as model/rating3/SPEC.md "Swing credits"
// describes. Values are win-probability fractions (0.05 = 5 points); HLTV shows a player's mean per
// round in percent.
//
// Provisional, as SPEC.md says: the round-end remainder rule is not fitted, and the flash share
// (params.json swing.flash_credit_fraction) comes from 23 clean observations. VALIDATION.md compares
// the result with HLTV's per-player swing.
import { PARAMS as params } from "./model-params";
import { enemyHit, hitDamage, type Ctx } from "./derive";
import type { KillFact, Measures } from "./facts";
import type { Side } from "./tables";
import { pTWins, type RoundState } from "./winprob";

const W = params.swing.round_end_remainder;
const FLASH = params.swing.flash_credit_fraction;

/** P(the side) wins, from P(T wins). */
const pSide = (pT: number, s: Side) => (s === "T" ? pT : 1 - pT);

export function swing(c: Ctx): void {
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    const rows = c.pr[ri];
    if (rf.winner === null) continue;
    const alive: Record<Side, Set<number>> = { CT: new Set(), T: new Set() };
    rows.forEach((p) => { if (p) alive[p.side].add(p.pi); });
    // health of the living, from the round's damage up to each event (CS2RB reads it)
    const hp = new Map<number, number>();
    rows.forEach((p) => { if (p) hp.set(p.pi, 100); });
    const dmgRows = c.byRound("damages")[ri];
    let nextDmg = 0;
    const hpUntil = (tick: number) => {
      const d = c.t.damages;
      for (; nextDmg < dmgRows.length && d.tick[dmgRows[nextDmg]] <= tick; nextDmg++) {
        const i = dmgRows[nextDmg];
        const v = c.pi.get(d.victim_steamid[i])!;
        if (hp.has(v)) hp.set(v, Math.max(0, d.health_after[i] ?? hp.get(v)! - d.dmg_health_capped[i]));
      }
      const sum = (s: Side) => [...alive[s]].reduce((t, p) => t + Math.min(100, hp.get(p) ?? 100), 0);
      state.hpT = sum("T"); state.hpCT = sum("CT");
    };
    const fe = rf.freezeEndTick;
    const at = (tick: number) => {
      hpUntil(tick);
      state.secondsSinceFreezeEnd = fe === null ? null : Math.max(0, (tick - fe) / c.tickRate);
      state.secondsSincePlant = state.planted && rf.plantTick !== null ? Math.max(0, (tick - rf.plantTick) / c.tickRate) : null;
      return pTWins(c.wp, state);
    };
    const state: RoundState = {
      map: c.map, aliveT: alive.T.size, aliveCT: alive.CT.size, hpT: 100 * alive.T.size, hpCT: 100 * alive.CT.size,
      equipT: rf.equip.T, equipCT: rf.equip.CT, planted: false, secondsSincePlant: null, secondsSinceFreezeEnd: null,
      buyT: rf.buy.T, buyCT: rf.buy.CT, lastKillSide: "none",
    };
    let pT = at(fe ?? 0);
    if (pT === null) continue;
    const path: NonNullable<typeof rf.winProb> = [{ tick: fe ?? c.t.rounds.start_tick[ri] ?? 0, event: "start", pT }];
    const credit = new Map<number, number>();
    const add = (p: number, v: number) => credit.set(p, (credit.get(p) ?? 0) + v);
    const killSwingPlayers = new Set<number>();
    const part = { opening: new Map<number, number>(), clutch: new Map<number, number>(), awp: new Map<number, number>(), flash: new Map<number, number>() };
    // Each credit's source, one per credit, so the sources sum to the player's swing: the killer's own
    // share of a kill (a trade kill's apart), a damage share of a teammate's kill, the flash share, the
    // victim's charge, and the round-end remainder.
    const source = { kill: new Map<number, number>(), trade: new Map<number, number>(), damage: new Map<number, number>(), death: new Map<number, number>(), end: new Map<number, number>() };
    const addPart = (m: Map<number, number>, p: number, v: number) => m.set(p, (m.get(p) ?? 0) + v);
    // a player's clutch starts when they are the last of their side alive
    const inClutch = new Set<number>();
    // HLTV's event graph stops at round end, so later kills are not valued.
    const events: ({ kind: "kill"; k: KillFact } | { kind: "plant"; tick: number })[] = c.kills[ri].filter((k) => k.tick <= rf.endTick).map((k) => ({ kind: "kill" as const, k }));
    if (rf.plantTick !== null && rf.plantTick <= rf.endTick) events.push({ kind: "plant", tick: rf.plantTick });
    events.sort((a, b) => (a.kind === "kill" ? a.k.tick : a.tick) - (b.kind === "kill" ? b.k.tick : b.tick));

    let valued = true;
    for (const e of events) {
      if (e.kind === "plant") {
        state.planted = true;
        const p = at(e.tick);
        if (p === null) { valued = false; break; }
        pT = p;
        path.push({ tick: e.tick, event: "plant", pT });
        continue;
      }
      const k = e.k;
      const vs = k.victimSide;
      if (vs === null || !alive[vs].has(k.victim)) continue;
      alive[vs].delete(k.victim);
      if (vs === "T") state.aliveT--; else state.aliveCT--;
      const gainer: Side = vs === "T" ? "CT" : "T";
      state.lastKillSide = gainer === "T" ? "t" : "ct";
      const p = at(k.tick);
      if (p === null) { valued = false; break; }
      const delta = pSide(p, gainer) - pSide(pT, gainer);
      pT = p;
      path.push({ tick: k.tick, event: "kill", pT });
      const credits: [number, number][] = [[k.victim, -delta]];
      addPart(source.death, k.victim, -delta);
      const own = k.tradeKill ? source.trade : source.kill;
      // positive credit: damage share of the gaining side's damage on the victim, else the killer
      const ledger = new Map<number, number>();
      for (const i of dmgRows) {
        if (c.t.damages.tick[i] > k.tick || c.t.damages.victim_steamid[i] !== c.players[k.victim].id || !enemyHit(c.t, i)) continue;
        const a = c.idOf(c.t.damages.attacker_steamid[i]);
        if (a === null || c.side[ri][a] !== gainer) continue;
        ledger.set(a, (ledger.get(a) ?? 0) + hitDamage(c.t, i));
      }
      const total = [...ledger.values()].reduce((s, v) => s + v, 0);
      const gain = Math.max(0, delta);
      // SPEC.md: an eligible flash (the gaining side's, on the victim, still blinding him at the kill;
      // not the killer's, a team flash or an ambiguous one) takes the flash share; the rest follows the
      // damage ledger, else the killer. Several flashers split the share equally (ours).
      const flashers = [...new Set(flashersOf(c, ri, k, gainer))];
      const rest = flashers.length ? gain * (1 - FLASH) : gain;
      for (const f of flashers) { credits.push([f, (gain * FLASH) / flashers.length]); addPart(part.flash, f, (gain * FLASH) / flashers.length); }
      if (total > 0) for (const [a, d] of ledger) { credits.push([a, (rest * d) / total]); addPart(a === k.killer ? own : source.damage, a, (rest * d) / total); }
      else if (k.enemy && k.killer !== null) { credits.push([k.killer, rest]); addPart(own, k.killer, rest); }
      k.credits = credits;
      const awpDuel = k.weapon === "awp" || k.victimWeapon === "AWP";
      for (const [pl, v] of credits) {
        add(pl, v);
        if (v > 0) killSwingPlayers.add(pl);
        if (k.opening) addPart(part.opening, pl, v);
        if (inClutch.has(pl)) addPart(part.clutch, pl, v);
        if (awpDuel && (pl === k.victim ? k.victimWeapon === "AWP" : k.weapon === "awp" && pl === k.killer)) addPart(part.awp, pl, v);
      }
      for (const s of ["CT", "T"] as const) if (alive[s].size === 1) inClutch.add([...alive[s]][0]);
    }
    if (!valued) { for (const k of c.kills[ri]) k.credits = []; continue; }

    // Round-end remainder: the winners split what the last event left, the losers are charged it.
    const winner = rf.winner;
    const loser: Side = winner === "T" ? "CT" : "T";
    const rest = 1 - pSide(pT, winner);
    const clutcher = alive[winner].size === 1 ? [...alive[winner]][0] : null;
    const defuser = rf.defused ? c.idOf(c.t.rounds.defuser_steamid[ri]) : null;
    const weights = new Map<number, number>();
    for (const p of rows) {
      if (!p || p.side !== winner) continue;
      let w = 0;
      if (p.pi === clutcher) w += W.clutcher_weight;
      if (killSwingPlayers.has(p.pi)) w += W.kill_swing_player_weight;
      if (p.pi === defuser) w += W.defuser_weight;
      if (alive[winner].has(p.pi)) w += W.survivor_weight;
      if (w > 0) weights.set(p.pi, w);
    }
    // A bomb win after the last T died can leave no eligible winner; then the winners share equally.
    if (weights.size === 0) for (const p of rows) if (p?.side === winner) weights.set(p.pi, 1);
    const wsum = [...weights.values()].reduce((s, v) => s + v, 0);
    for (const [pl, w] of weights) { add(pl, (rest * w) / wsum); addPart(source.end, pl, (rest * w) / wsum); }
    const losers = alive[loser].size ? [...alive[loser]] : rows.filter((p) => p?.side === loser).map((p) => p!.pi);
    for (const pl of losers) { add(pl, -rest / losers.length); addPart(source.end, pl, -rest / losers.length); }

    rf.winProb = path;
    // round win shares: in a won round, the player's share of the team's positive swing
    const teamGain = rows.reduce((s, p) => s + (p && p.side === winner ? Math.max(0, credit.get(p.pi) ?? 0) : 0), 0);
    const winners = rows.filter((p) => p?.side === winner).length;
    for (const p of rows) {
      if (!p) continue;
      const v = credit.get(p.pi) ?? 0;
      p.m.swing += v;
      p.m.swingRounds++;
      p.m.openingSwing += part.opening.get(p.pi) ?? 0;
      p.m.clutchSwing += part.clutch.get(p.pi) ?? 0;
      p.m.awpSwing += part.awp.get(p.pi) ?? 0;
      p.m.flashSwing += part.flash.get(p.pi) ?? 0;
      p.m.swingKills += source.kill.get(p.pi) ?? 0;
      p.m.swingTrades += source.trade.get(p.pi) ?? 0;
      p.m.swingDamage += source.damage.get(p.pi) ?? 0;
      p.m.swingDeaths += source.death.get(p.pi) ?? 0;
      p.m.swingEnd += source.end.get(p.pi) ?? 0;
      if (p.side === winner) { p.m.rwsRounds++; p.m.rws += teamGain > 0 ? Math.max(0, v) / teamGain : 1 / winners; }
    }
  }
}

/** Players on the gaining side whose flash was blinding the victim at the kill (SPEC.md's eligible flashes). */
function flashersOf(c: Ctx, ri: number, k: KillFact, gainer: Side): number[] {
  const b = c.t.blinds;
  const out: number[] = [];
  for (const i of c.byRound("blinds")[ri]) {
    if (b.is_team_flash[i] || b.is_self[i] || b.ambiguous[i] || b.tick[i] > k.tick || k.tick > b.tick[i] + b.duration[i] * c.tickRate) continue;
    if (c.pi.get(b.victim_steamid[i]) !== k.victim) continue;
    const a = c.idOf(b.attacker_steamid[i]);
    if (a !== null && a !== k.killer && c.side[ri][a] === gainer) out.push(a);
  }
  return out;
}

/** Swing by source, each in percent per valued round like the swing metric; null without valued rounds. The six sum to swing. */
export interface SwingSources { kills: number; trades: number; damage: number; flashes: number; deaths: number; roundEnd: number }

export function swingSources(m: Measures): SwingSources | null {
  if (!m.swingRounds) return null;
  const pct = (x: number) => (100 * x) / m.swingRounds;
  return {
    kills: pct(m.swingKills), trades: pct(m.swingTrades), damage: pct(m.swingDamage), flashes: pct(m.flashSwing),
    deaths: pct(m.swingDeaths), roundEnd: pct(m.swingEnd),
  };
}
