// Builds small schema-v1 matches for known-answer tests. Players 0..4 are CT, 5..9 are T, and the
// human is player 0, unless a test overrides sides per round.
import { emptyTables, validateMatch, type GrenadeType, type KillState, type MatchFile, type RoundHow, type Side } from "../schema";

export const TR = 64;
const FREEZE0 = 10_000;
const ROUND_TICKS = 64 * 200;

export class MatchBuilder {
  m: MatchFile;
  constructor(nRounds = 1, nPlayers = 10) {
    const sides = Array.from({ length: nPlayers }, (_, i) => (i < nPlayers / 2 ? 3 : 2) as Side);
    this.m = {
      v: 1, id: "test", map: "de_test", startUtc: "2026-01-01T00:00:00.000Z", endUtc: "2026-01-01T00:30:00.000Z",
      status: "complete", env: { plugin: "test", cssharp: null, game: null, tickrate: TR, maxrounds: 24, botDifficulty: null },
      firstFullRound: 0, weapons: [], places: [], human: 0,
      players: {
        key: sides.map((_, i) => (i === 0 ? "7656119" : `B:p${i}`)), name: sides.map((_, i) => `p${i}`),
        isBot: sides.map((_, i) => i !== 0), startSide: sides,
      },
      rounds: {
        winSide: [], how: [], freezeTick: [], durTicks: [], bombSite: [], plantTick: [], planter: [], defuser: [],
        ctSetup: [], score: [], side: [], equip: [], money: [],
      },
      ...emptyTables(),
    };
    for (let ri = 0; ri < nRounds; ri++) this.round(ri, 3, "elim");
  }
  /** tick at `secs` into round ri */
  t(ri: number, secs: number) { return FREEZE0 + ri * ROUND_TICKS + Math.round(secs * TR); }
  w(name: string) {
    let i = this.m.weapons.indexOf(name);
    if (i < 0) { i = this.m.weapons.length; this.m.weapons.push(name); }
    return i;
  }
  round(ri: number, win: Side, how: RoundHow, opts: { equip?: (number | null)[]; money?: (number | null)[]; side?: (Side | null)[]; dur?: number } = {}) {
    const r = this.m.rounds;
    const n = this.m.players.key.length;
    r.winSide[ri] = win; r.how[ri] = how; r.freezeTick[ri] = this.t(ri, 0); r.durTicks[ri] = Math.round((opts.dur ?? 100) * TR);
    r.bombSite[ri] = null; r.plantTick[ri] = null; r.planter[ri] = null; r.defuser[ri] = null; r.ctSetup[ri] = null;
    r.score[ri] = [0, 0];
    r.side[ri] = opts.side ?? [...this.m.players.startSide];
    r.equip[ri] = opts.equip ?? new Array(n).fill(4700);
    r.money[ri] = opts.money ?? new Array(n).fill(1000);
    return this;
  }
  kill(ri: number, secs: number, killer: number | null, victim: number, o: { weapon?: string; hs?: boolean; assister?: number; flash?: number; state?: KillState } = {}) {
    const k = this.m.kills;
    k.ri.push(ri); k.tick.push(this.t(ri, secs)); k.killer.push(killer); k.victim.push(victim);
    k.assister.push(o.assister ?? o.flash ?? null); k.flashAssister.push(o.flash ?? null);
    k.weapon.push(this.w(o.weapon ?? "ak47")); k.flags.push(o.hs ? 1 : 0); k.kpos.push(null); k.vpos.push(null);
    k.state.push(o.state ?? null);
    return this;
  }
  damage(ri: number, secs: number, attacker: number, victim: number, dmg: number, weapon = "ak47", hitgroup = 2) {
    const d = this.m.damage;
    d.ri.push(ri); d.tick.push(this.t(ri, secs)); d.attacker.push(attacker); d.victim.push(victim); d.dmg.push(dmg);
    d.dmgArmor.push(0); d.weapon.push(this.w(weapon)); d.hitgroup.push(hitgroup);
    return this;
  }
  blind(ri: number, secs: number, attacker: number, victim: number, ms: number) {
    const b = this.m.blinds;
    b.ri.push(ri); b.tick.push(this.t(ri, secs)); b.attacker.push(attacker); b.victim.push(victim); b.ms.push(ms);
    return this;
  }
  grenade(ri: number, secs: number, thrower: number, type: GrenadeType) {
    const g = this.m.grenades;
    g.ri.push(ri); g.tick.push(this.t(ri, secs)); g.thrower.push(thrower); g.type.push(type); g.pos.push(null);
    return this;
  }
  shot(ri: number, tick: number, o: { weapon?: string; speed?: number | null; maxSpeed?: number | null; target?: number | null; hit?: number | null; impact?: [number, number] | null } = {}) {
    const s = this.m.aim.shots;
    s.ri.push(ri); s.tick.push(tick); s.weapon.push(this.w(o.weapon ?? "ak47")); s.burst.push(0); s.idx.push(0);
    s.speed.push(o.speed === undefined ? 0 : o.speed); s.maxSpeed.push(o.maxSpeed === undefined ? 215 : o.maxSpeed);
    s.scoped.push(false); s.ducked.push(false); s.target.push(o.target === undefined ? 5 : o.target);
    s.aimErr.push(null); s.impact.push(o.impact ?? null); s.hit.push(o.hit === undefined ? null : o.hit);
    return this;
  }
  build(): MatchFile {
    return validateMatch(structuredClone(this.m), "test");
  }
}
