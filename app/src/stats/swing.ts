// Round swing, HLTV's "Swing": each event's change in the round win probability (winprob.ts, from the
// source the match was derived with), credited to players as model/rating3/SPEC.md "Swing credits"
// describes. Values are win-probability fractions (0.05 = 5 points); HLTV shows a player's mean per
// round in percent.
//
// The kill shares and the defuse share follow params.json swing.event_credit, fitted to HLTV's own
// credits by model/rating3/swing_credit_fit.py. The winners' split of a time-out is ours (HLTV's is
// not recovered). VALIDATION.md compares the result with HLTV's per-player swing.
import { blindWindows } from "./blinds";
import { PARAMS as params } from "./model-params";
import { enemyHit, hitDamage, type Ctx } from "./derive";
import type { KillFact, Measures } from "./facts";
import { roundPopulation } from "./rules";
import type { Side } from "./tables";
import { pTWins, type RoundState } from "./winprob";

const E = params.swing.event_credit;

/** P(the side) wins, from P(T wins). */
const pSide = (pT: number, s: Side) => (s === "T" ? pT : 1 - pT);

export function swing(c: Ctx): void {
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    const rows = c.pr[ri];
    if (rf.winner === null) continue;
    // the players in the live round, and its deaths and disconnects (rules.ts roundPopulation), as the
    // clutch and man-advantage counts read them
    const { alive, deaths, leaves } = roundPopulation(rf, rows, c.kills[ri]);
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
    const part = { opening: new Map<number, number>(), clutch: new Map<number, number>(), awp: new Map<number, number>(), flash: new Map<number, number>() };
    // Each credit's source, one per credit, so the sources sum to the player's swing: the killer's own
    // share of a kill (a trade kill's apart, with the share a traded teammate gets back), a damage share
    // of a teammate's kill, the flash share, the victim's and a failed trader's charge, and the share of
    // a plant, a defuse or the round's end.
    const source = { kill: new Map<number, number>(), trade: new Map<number, number>(), damage: new Map<number, number>(), death: new Map<number, number>(), end: new Map<number, number>() };
    const addPart = (m: Map<number, number>, p: number, v: number) => m.set(p, (m.get(p) ?? 0) + v);
    // a player's clutch starts when they are the last of their side alive
    const inClutch = new Set<number>();
    // Every valued event so far: its change in P(T wins) and the credits it gave, each signed for the
    // side it favoured, as replay reads them.
    const history: { dT: number; credits: [number, number][] }[] = [];
    // where the plant falls in history, and who was alive on each side when it did
    let plantAt: number | null = null;
    let aliveAtPlant: Record<Side, Set<number>> | null = null;
    // A plant's, a defuse's or the round end's change in P(T wins), dT, shared like the round's earlier
    // events that moved it the same way, each in proportion to its own change (HLTV's plant and defuse
    // credits, SPEC.md). With no such event, each side's living players share it equally.
    const replay = (dT: number): [number, number][] => {
      const same = history.filter((h) => h.dT !== 0 && Math.sign(h.dT) === Math.sign(dT));
      const sum = same.reduce((t, h) => t + Math.abs(h.dT), 0);
      if (sum > 0) return same.flatMap((h) => h.credits.map(([pl, v]): [number, number] => [pl, (v * Math.abs(dT)) / sum]));
      const gainer: Side = dT > 0 ? "T" : "CT";
      return [...evenly(alive[gainer], Math.abs(dT)), ...evenly(alive[gainer === "T" ? "CT" : "T"], -Math.abs(dT))];
    };
    const credited = (cr: [number, number][], m: Map<number, number>) => { for (const [pl, v] of cr) { add(pl, v); addPart(m, pl, v); } };
    // HLTV's event graph stops at round end, so later kills are not valued. A disconnect moves the win
    // probability as a death does but credits no one (ours): nobody's action caused it. On one tick a
    // death comes before a disconnect, and both before a plant.
    type Ev = { kind: "kill"; k: KillFact; tick: number } | { kind: "leave"; pi: number; tick: number } | { kind: "plant"; tick: number };
    const events: Ev[] = [...deaths.map((k): Ev => ({ kind: "kill", k, tick: k.tick })), ...leaves.map((l): Ev => ({ kind: "leave", pi: l.pi, tick: l.tick }))];
    if (rf.plantTick !== null && rf.plantTick <= rf.endTick) events.push({ kind: "plant", tick: rf.plantTick });
    const rank = { kill: 0, leave: 1, plant: 2 } as const;
    events.sort((a, b) => a.tick - b.tick || rank[a.kind] - rank[b.kind]);
    const enemyDeaths = deaths.filter((k) => k.enemy && k.killer !== null);
    const window = E.trade_window_seconds * c.tickRate;

    let valued = true;
    for (const e of events) {
      if (e.kind === "plant") {
        state.planted = true;
        const p = at(e.tick);
        if (p === null) { valued = false; break; }
        const cr = replay(p - pT);
        credited(cr, source.end);
        plantAt = history.length;
        aliveAtPlant = { CT: new Set(alive.CT), T: new Set(alive.T) };
        history.push({ dT: p - pT, credits: cr });
        pT = p;
        path.push({ tick: e.tick, event: "plant", pT });
        continue;
      }
      if (e.kind === "leave") {
        const side = alive.CT.has(e.pi) ? "CT" : alive.T.has(e.pi) ? "T" : null;
        if (side === null) continue;
        alive[side].delete(e.pi);
        if (side === "T") state.aliveT--; else state.aliveCT--;
        const p = at(e.tick);
        if (p === null) { valued = false; break; }
        pT = p;
        path.push({ tick: e.tick, event: "leave", pT });
        for (const s of ["CT", "T"] as const) if (alive[s].size === 1) inClutch.add([...alive[s]][0]);
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
      const credits: [number, number][] = [];
      const own = k.tradeKill ? source.trade : source.kill;
      // Positive credit (SPEC.md "Swing credits"): the gaining side shares the gain by weight. Each
      // player weighs the HP-capped damage they did to the victim this round; the killer adds the kill
      // weight, each eligible flasher the flash weight, and the earliest teammate the victim killed
      // within the trade window the trade weight.
      const shares: { pl: number; w: number; to: Map<number, number> }[] = [];
      for (const i of dmgRows) {
        if (c.t.damages.tick[i] > k.tick || c.t.damages.victim_steamid[i] !== c.players[k.victim].id || !enemyHit(c.t, i)) continue;
        const a = c.idOf(c.t.damages.attacker_steamid[i]);
        if (a === null || c.side[ri][a] !== gainer) continue;
        shares.push({ pl: a, w: hitDamage(c.t, i), to: a === k.killer ? own : source.damage });
      }
      let failed: KillFact | undefined;
      if (k.enemy && k.killer !== null) {
        shares.push({ pl: k.killer, w: E.kill_weight, to: own });
        for (const f of new Set(flashersOf(c, ri, k, gainer))) shares.push({ pl: f, w: E.flash_weight, to: part.flash });
        const traded = enemyDeaths.find((d) => d.killer === k.victim && d.victimSide === gainer && d.tick <= k.tick && k.tick - d.tick <= window);
        if (traded) shares.push({ pl: traded.victim, w: E.trade_weight, to: source.trade });
        failed = enemyDeaths.find((d) => d.killer === k.killer && d.victimSide === vs && d.tick > k.tick && d.tick - k.tick <= window);
      }
      const total = shares.reduce((t, x) => t + x.w, 0);
      const gain = Math.max(0, delta);
      if (total > 0) for (const x of shares) { const v = (gain * x.w) / total; credits.push([x.pl, v]); add(x.pl, v); addPart(x.to, x.pl, v); }
      // The victim's charge, shared with a teammate the same killer killed within the trade window
      // after (a failed trade), by the victim and failed-trade weights.
      const debits: [number, number][] = failed ? [[k.victim, E.victim_weight], [failed.victim, E.failed_trade_weight]] : [[k.victim, 1]];
      const dsum = debits.reduce((t, [, w]) => t + w, 0);
      for (const [pl, w] of debits) { const v = (-delta * w) / dsum; credits.push([pl, v]); add(pl, v); addPart(source.death, pl, v); }
      k.credits = credits;
      // signed for the side the kill favoured: delta is the gaining side's change
      history.push({ dT: gainer === "T" ? delta : -delta, credits });
      const awpDuel = k.weapon === "awp" || k.victimWeapon === "AWP";
      for (const [pl, v] of credits) {
        if (k.opening) addPart(part.opening, pl, v);
        if (inClutch.has(pl)) addPart(part.clutch, pl, v);
        if (awpDuel && (pl === k.victim ? k.victimWeapon === "AWP" : k.weapon === "awp" && pl === k.killer)) addPart(part.awp, pl, v);
      }
      for (const s of ["CT", "T"] as const) if (alive[s].size === 1) inClutch.add([...alive[s]][0]);
    }
    if (!valued) { for (const k of c.kills[ri]) k.credits = []; continue; }

    // The round's end: what the last event left (SPEC.md "Swing credits", fitted to HLTV's credits).
    // - A defuse: the defuser takes the defuse share and the winners' credits from the events since the
    //   plant that moved the round their way take the rest; the losers alive at the plant share the charge.
    // - A detonation: the winners' credits from those events take it all, else the winners alive share
    //   it; the losers alive share the charge.
    // - The clock running out: each side's living players share it equally.
    // - An elimination's remainder replays the round's events.
    const winner = rf.winner;
    const loser: Side = winner === "T" ? "CT" : "T";
    const rest = 1 - pSide(pT, winner);
    const sign = winner === "T" ? 1 : -1;
    const winnersSincePlant = (amount: number): [number, number][] => {
      if (plantAt === null) return [];
      const pos = history.slice(plantAt + 1).filter((h) => Math.sign(h.dT) === sign).flatMap((h) => h.credits.filter(([, v]) => v > 0));
      const sum = pos.reduce((t, [, v]) => t + v, 0);
      return sum > 0 ? pos.map(([pl, v]): [number, number] => [pl, (amount * v) / sum]) : [];
    };
    const everyone = (side: Side) => rows.filter((p) => p?.side === side).map((p) => p!.pi);
    const orAll = (set: Set<number> | undefined, side: Side) => (set && set.size ? [...set] : everyone(side));
    if (rest !== 0) {
      if (rf.defused && rf.defuser !== null && plantAt !== null) {
        const replayed = winnersSincePlant(rest * (1 - E.defuse_share));
        const own = replayed.length ? rest * E.defuse_share : rest;
        credited([[rf.defuser, own], ...replayed, ...evenly(orAll(aliveAtPlant?.[loser], loser), -rest)], source.end);
      } else if (rf.exploded && !rf.defused) {
        const replayed = winnersSincePlant(rest);
        const winners = replayed.length ? replayed : evenly(orAll(alive[winner], winner), rest);
        credited([...winners, ...evenly(orAll(alive[loser], loser), -rest)], source.end);
      } else if (rf.reason === "time_ran_out" && alive[winner].size > 0) {
        credited([...evenly(alive[winner], rest), ...evenly(orAll(alive[loser], loser), -rest)], source.end);
      } else {
        credited(replay(sign * rest), source.end);
      }
    }

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

/** `total` split equally over `players`, as [player, share] pairs; none when there are no players. */
function evenly(players: Iterable<number>, total: number): [number, number][] {
  const list = [...players];
  return list.map((p) => [p, total / list.length]);
}

/** Players on the gaining side whose flash was blinding the victim at the kill (SPEC.md's eligible flashes). */
function flashersOf(c: Ctx, ri: number, k: KillFact, gainer: Side): number[] {
  const out: number[] = [];
  // repeated blind rows joined (blinds.ts), so a duplicated row does not count its flasher twice
  for (const b of blindWindows(c.t).get(c.rounds[ri].number) ?? []) {
    if (b.team || b.self || b.ambiguous || b.tick > k.tick || k.tick > b.tick + b.secs * c.tickRate) continue;
    if (c.pi.get(b.victim) !== k.victim) continue;
    const a = c.idOf(b.attacker);
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
