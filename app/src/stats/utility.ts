// Utility usage: grenades bought, thrown and where they landed, enemies and teammates flashed,
// flash-to-kills, grenade damage dealt and taken, and grenades a player died holding. Flash definitions are Leetify's (research-data-sources.md): an enemy counts as flashed
// at more than 1.1 s of blind, and a flash-to-kill is a flashed enemy dying to the team while still
// blind. Utility quality beyond usage (smokes) is utilq.ts.
import { enemyHit, hitDamage, type Ctx } from "./derive";
import type { GrenadeFact } from "./facts";
import { classFromDisplay, isUtility, PRICE } from "./weapons";

/** Leetify: blind longer than this counts as flashed. */
export const FLASHED_MIN_S = 1.1;

const THROWN: Record<string, "smokes" | "flashes" | "hes" | "molotovs" | null> = {
  smokegrenade: "smokes", flashbang: "flashes", hegrenade: "hes", molotov: "molotovs", incgrenade: "molotovs", decoy: null,
};

/** Damage rows from fire name the grenade or the fire itself. */
const FIRE = new Set(["molotov", "incgrenade", "inferno"]);

export function utility(c: Ctx): void {
  const g = c.t.grenade_throws;
  const b = c.t.blinds;
  const d = c.t.damages;
  const inv = c.t.player_rounds;
  const loadout = inv.best_primary.some((x) => x !== null) || inv.inventory.some((x) => x.length > 0);
  const held = new Map<number, string[]>();
  for (let i = 0; i < inv.n; i++) {
    const ri = c.riOf(inv.round[i]);
    if (ri !== undefined) held.set(ri * 1024 + c.pi.get(inv.steamid[i])!, inv.inventory[i].map(classFromDisplay).filter((x) => x in THROWN));
  }

  for (let ri = 0; ri < c.nRounds; ri++) {
    const rows = c.pr[ri];
    const row = (id: string | null) => { const p = c.idOf(id); return p === null ? null : rows[p]; };
    const throws: [number, number, string][] = []; // [player, tick, class]
    if (g) for (const i of c.byRound("grenade_throws")[ri]) {
      const p = row(g.steamid[i]);
      if (!p || !(g.weapon[i] in THROWN)) continue;
      const kind = THROWN[g.weapon[i]];
      if (kind) p.m[kind]++;
      throws.push([p.pi, g.tick[i], g.weapon[i]]);
    }

    for (const i of c.byRound("blinds")[ri]) {
      const p = row(b.attacker_steamid[i]);
      if (!p || b.duration[i] <= FLASHED_MIN_S || b.is_self[i]) continue;
      if (b.is_team_flash[i]) { p.m.teamFlashed++; p.m.teamBlindSecs += b.duration[i]; continue; }
      p.m.enemiesFlashed++;
      p.m.enemyBlindSecs += b.duration[i];
      const v = c.pi.get(b.victim_steamid[i])!;
      const until = b.tick[i] + b.duration[i] * c.tickRate;
      if (c.kills[ri].some((k) => k.enemy && k.victim === v && k.killerSide === p.side && k.tick >= b.tick[i] && k.tick <= until)) p.m.flashKills++;
    }

    for (const i of c.byRound("damages")[ri]) {
      const w = d.weapon[i] ?? "";
      if (!isUtility(w) || !enemyHit(c.t, i)) continue;
      const x = hitDamage(c.t, i);
      const v = row(d.victim_steamid[i]);
      if (v) v.m.utilDmgTaken += x;
      const a = row(d.attacker_steamid[i]);
      if (!a) continue;
      a.m.utilDmg += x;
      if (w === "hegrenade") a.m.heDmg += x;
      if (FIRE.has(w)) a.m.fireDmg += x;
    }

    // grenades bought, less those refunded in the buy zone
    const buys = c.t.purchases;
    if (buys) {
      for (const p of rows) if (p) p.m.purchaseRounds = 1;
      for (const i of c.byRound("purchases")[ri]) {
        const p = row(buys.steamid[i]);
        if (p && !buys.was_sold[i] && isUtility(classFromDisplay(buys.item[i]))) p.m.utilSpent += buys.cost[i];
      }
    }

    // grenades held: the freeze-end inventory, less those thrown before death; a source without
    // inventories leaves this unmeasured (its metric gets no percentile), not $0
    if (!loadout) continue;
    for (const p of rows) {
      if (!p) continue;
      const death = c.kills[ri].find((k) => k.victim === p.pi);
      if (!death) continue;
      const left = [...(held.get(ri * 1024 + p.pi) ?? [])];
      for (const [pl, tick, cls] of throws) {
        if (pl !== p.pi || tick > death.tick) continue;
        const j = left.indexOf(cls);
        if (j >= 0) left.splice(j, 1);
      }
      p.m.utilUnused += left.reduce((s, x) => s + PRICE[x], 0);
      p.m.utilDeaths++;
    }
  }
}

/** Every grenade thrown by a player who played the round, with where it was thrown from and landed. */
export function grenadeFacts(c: Ctx): GrenadeFact[] {
  const g = c.t.grenade_throws;
  if (!g) return [];
  const xy = (x: number | null, y: number | null): [number, number] | null => (x === null || y === null ? null : [Math.round(x), Math.round(y)]);
  const out: GrenadeFact[] = [];
  for (let ri = 0; ri < c.nRounds; ri++) {
    const fe = c.rounds[ri].freezeEndTick;
    for (const i of c.byRound("grenade_throws")[ri]) {
      const p = c.idOf(g.steamid[i]);
      if (p === null || !c.pr[ri][p] || !(g.weapon[i] in THROWN)) continue;
      out.push({ ri, pi: p, weapon: g.weapon[i], t: fe === null ? null : (g.tick[i] - fe) / c.tickRate, from: xy(g.x[i], g.y[i]), land: xy(g.land_x[i], g.land_y[i]) });
    }
  }
  return out;
}
