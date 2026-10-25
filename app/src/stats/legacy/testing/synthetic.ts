// Deterministic synthetic match with every table filled (aim and positions included), for
// integration and performance tests and for checking the Aim and Positions views. It is not real
// play data; env.plugin is "synthetic-demo" and the UI labels it.
import { emptyTables, type GrenadeType, type KillState, type MatchFile, type Side } from "../schema";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rough Dust II-like corridors: [x, y, place]
const ROUTES: [number, number, string][][] = [
  [[-600, -800, "TSpawn"], [-300, 400, "OutsideLong"], [500, 600, "LongDoors"], [1300, 1200, "LongA"], [1200, 2400, "BombsiteA"]],
  [[-600, -800, "TSpawn"], [-400, 900, "Middle"], [-300, 1500, "MidDoors"], [200, 1900, "Catwalk"], [1000, 2400, "BombsiteA"]],
  [[-600, -800, "TSpawn"], [-1500, 300, "UpperTunnel"], [-1900, 1300, "UpperTunnel"], [-1600, 2500, "BombsiteB"]],
  [[300, 2400, "CTSpawn"], [800, 2500, "ARamp"], [1300, 2600, "BombsiteA"]],
  [[300, 2400, "CTSpawn"], [-400, 2100, "MidDoors"], [-1300, 2500, "BombsiteB"]],
];

export function syntheticMatch(seed = 1, nRounds = 24): MatchFile {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const names = ["You", "Rip", "Delrow", "Ricksaw", "Rebel", "Buckshot", "Gunner", "Crusher", "Stone", "Shark"];
  const startSide = names.map((_, i) => (i < 5 ? 2 : 3) as Side);
  const places = [...new Set(ROUTES.flat().map((p) => p[2]))];
  const weapons = ["ak47", "m4a1_silencer", "awp", "glock", "usp_silencer", "hegrenade", "inferno", "deagle"];
  const W = (n: string) => weapons.indexOf(n);
  const t = emptyTables();
  const m: MatchFile = {
    v: 1, id: `synthetic${seed}`.padEnd(32, "0").slice(0, 32), map: "de_dust2",
    startUtc: new Date(Date.UTC(2026, 9, 1 + (seed % 28), 18, 0, 0)).toISOString(),
    endUtc: new Date(Date.UTC(2026, 9, 1 + (seed % 28), 18, 42, 0)).toISOString(), status: "complete",
    env: { plugin: "synthetic-demo", cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: 3 },
    firstFullRound: 0, weapons, places, human: 0,
    players: { key: names.map((n, i) => (i === 0 ? "76561190000000001" : `B:${n}`)), name: names, isBot: names.map((_, i) => i > 0), startSide },
    rounds: { winSide: [], how: [], freezeTick: [], durTicks: [], bombSite: [], plantTick: [], planter: [], defuser: [], ctSetup: [], score: [], side: [], equip: [], money: [] },
    ...t,
  };
  let tick = 1000;
  const score: Record<Side, number> = { 2: 0, 3: 0 };
  for (let ri = 0; ri < nRounds; ri++) {
    const half = ri >= 12;
    const side = startSide.map((s) => (half ? ((5 - s) as Side) : s));
    const freeze = tick;
    const pistol = ri % 12 === 0;
    const equip = side.map(() => (pistol ? 200 + Math.round(r() * 3) * 100 : r() < 0.25 ? 700 + Math.round(r() * 4) * 100 : 4200 + Math.round(r() * 10) * 100));
    const money = side.map(() => Math.round(r() * 30) * 100);
    m.rounds.side.push(side); m.rounds.equip.push(equip); m.rounds.money.push(money);
    m.rounds.score.push([score[2], score[3]]);
    m.rounds.freezeTick.push(freeze); m.rounds.ctSetup.push(null);
    const alive = new Set(names.map((_, i) => i));
    const hp = names.map(() => 100);
    let plantTick: number | null = null;
    let tt = freeze + 64 * (10 + r() * 15);
    const bySide = (s: Side) => [...alive].filter((p) => side[p] === s);
    while (bySide(2).length && bySide(3).length && tt < freeze + 64 * 110) {
      const killerSide: Side = r() < 0.5 ? 2 : 3;
      const killer = killerSide === side[0] && alive.has(0) && r() < 0.42 ? 0 : pick(bySide(killerSide));
      const victim = pick(bySide((5 - killerSide) as Side));
      if (killer === undefined || victim === undefined) break;
      const wpn = pistol ? (side[killer] === 2 ? "glock" : "usp_silencer") : r() < 0.15 ? "awp" : side[killer] === 2 ? "ak47" : "m4a1_silencer";
      // a chip of damage from a teammate first, sometimes
      if (r() < 0.4) {
        const mate = pick(bySide(killerSide));
        if (mate !== undefined) {
          const d = 20 + Math.round(r() * 40);
          t.damage.ri.push(ri); t.damage.tick.push(tt - 40); t.damage.attacker.push(mate); t.damage.victim.push(victim);
          t.damage.dmg.push(d); t.damage.dmgArmor.push(5); t.damage.weapon.push(W(side[mate] === 2 ? "ak47" : "m4a1_silencer")); t.damage.hitgroup.push(2);
          hp[victim] -= d;
        }
      }
      const hs = r() < 0.45;
      t.damage.ri.push(ri); t.damage.tick.push(tt); t.damage.attacker.push(killer); t.damage.victim.push(victim);
      t.damage.dmg.push(Math.max(1, hp[victim])); t.damage.dmgArmor.push(10); t.damage.weapon.push(W(wpn)); t.damage.hitgroup.push(hs ? 1 : 2);
      const state: KillState = [bySide(3).length, bySide(2).length, bySide(3).reduce((a, p) => a + Math.max(0, hp[p]), 0) - (side[victim] === 3 ? hp[victim] : 0),
        bySide(2).reduce((a, p) => a + Math.max(0, hp[p]), 0) - (side[victim] === 2 ? hp[victim] : 0),
        bySide(3).reduce((a, p) => a + equip[p], 0), bySide(2).reduce((a, p) => a + equip[p], 0), plantTick ? 1 : 0, plantTick ? tt - plantTick : null];
      hp[victim] = 0;
      const route = pick(ROUTES);
      const wp = route[Math.min(route.length - 1, 1 + Math.floor(r() * (route.length - 1)))];
      const vx = wp[0] + (r() - 0.5) * 300;
      const vy = wp[1] + (r() - 0.5) * 300;
      t.kills.ri.push(ri); t.kills.tick.push(tt); t.kills.killer.push(killer); t.kills.victim.push(victim);
      t.kills.assister.push(null); t.kills.flashAssister.push(null); t.kills.weapon.push(W(wpn)); t.kills.flags.push(hs ? 1 : 0);
      t.kills.kpos.push([Math.round(vx + (r() - 0.5) * 900), Math.round(vy + (r() - 0.5) * 900), 0]); t.kills.vpos.push([Math.round(vx), Math.round(vy), 0]);
      t.kills.state.push(state);
      alive.delete(victim);
      if (!plantTick && side[killer] === 2 && r() < 0.2) plantTick = tt + 64 * 5;
      tt += Math.round(64 * (2 + r() * 14));
    }
    const ctLeft = bySide(3).length;
    const tLeft = bySide(2).length;
    const winSide: Side = ctLeft === 0 ? 2 : tLeft === 0 ? 3 : r() < 0.5 ? 2 : 3;
    m.rounds.winSide.push(winSide);
    m.rounds.how.push(ctLeft === 0 || tLeft === 0 ? "elim" : winSide === 2 ? "bomb" : "time");
    m.rounds.durTicks.push(tt - freeze);
    m.rounds.bombSite.push(plantTick ? "A" : null); m.rounds.plantTick.push(plantTick); m.rounds.planter.push(plantTick ? bySide(2)[0] ?? null : null); m.rounds.defuser.push(null);
    score[winSide]++;

    // utility
    for (let g = 0; g < 4; g++) {
      const thrower = Math.floor(r() * 10);
      const type = pick<GrenadeType>(["flash", "smoke", "he", "molotov"]);
      t.grenades.ri.push(ri); t.grenades.tick.push(freeze + 64 * (5 + g * 6)); t.grenades.thrower.push(thrower); t.grenades.type.push(type); t.grenades.pos.push([0, 1000, 0]);
      if (type === "flash") {
        const victim = Math.floor(r() * 10);
        t.blinds.ri.push(ri); t.blinds.tick.push(freeze + 64 * (5 + g * 6) + 20); t.blinds.attacker.push(thrower); t.blinds.victim.push(victim); t.blinds.ms.push(Math.round(r() * 3500));
      }
    }

    // human positions at 4 Hz, bots at 1 Hz, along one route per player
    for (let p = 0; p < 10; p++) {
      const route = side[p] === 3 ? pick(ROUTES.slice(3)) : pick(ROUTES.slice(0, 3));
      const deathTick = t.kills.tick.find((k, j) => t.kills.ri[j] === ri && t.kills.victim[j] === p) ?? tt;
      const step = p === 0 ? 16 : 64;
      for (let k = freeze; k <= deathTick; k += step) {
        const f = Math.min(1, (k - freeze) / (64 * 60)) * (route.length - 1);
        const i = Math.min(route.length - 2, Math.floor(f));
        const u = f - i;
        const a = route[i];
        const b = route[i + 1];
        t.pos.ri.push(ri); t.pos.tick.push(k); t.pos.pi.push(p);
        t.pos.x.push(Math.round(a[0] + (b[0] - a[0]) * u + (r() - 0.5) * 160)); t.pos.y.push(Math.round(a[1] + (b[1] - a[1]) * u + (r() - 0.5) * 160));
        t.pos.z.push(0); t.pos.place.push(places.indexOf(u < 0.5 ? a[2] : b[2])); t.pos.alive.push(true);
      }
    }

    // aim: a few engagements and sprays per round for the human
    for (let e = 0; e < 3; e++) {
      const tVis = freeze + 64 * (8 + e * 20) + Math.floor(r() * 64);
      const enemy = pick(names.map((_, i) => i).filter((i) => side[i] !== side[0]));
      const react = Math.round(64 * (0.15 + r() * 0.25));
      const ttd = react + Math.round(64 * (0.1 + r() * 0.5));
      const ang = Math.round((1 + r() ** 2 * 18) * 100);
      const a = t.aim.engagements;
      a.ri.push(ri); a.enemy.push(enemy); a.tVis.push(tVis); a.angVis.push(ang); a.angVisYaw.push(Math.round(ang * 0.8)); a.angVisPitch.push(Math.round(ang * 0.3));
      a.dist.push(Math.round(400 + r() * 1800)); a.tAimStart.push(tVis + react); a.tFirstShot.push(tVis + react + 8); a.tFirstDmg.push(r() < 0.8 ? tVis + ttd : null);
      a.tEnd.push(tVis + 64 * 3); a.outcome.push(pick(["kill", "died", "none"]));
      const burstLen = 1 + Math.floor(r() * 12);
      const w = pistol ? (side[0] === 2 ? "glock" : "usp_silencer") : side[0] === 2 ? "ak47" : "m4a1_silencer";
      for (let b = 1; b <= burstLen; b++) {
        const s = t.aim.shots;
        // AK-like pattern: up for 7 bullets, then right, then left
        const up = Math.min(b - 1, 7) * 0.55;
        const side_ = b > 8 ? (b < 14 ? (b - 8) * 0.35 : (20 - b) * -0.3) : 0;
        s.ri.push(ri); s.tick.push(tVis + react + 8 + (b - 1) * 6); s.weapon.push(W(w)); s.burst.push(e); s.idx.push(b);
        const sp = b === 1 ? (r() < 0.65 ? r() * 60 : 80 + r() * 140) : r() * 40;
        s.speed.push(Math.round(sp)); s.maxSpeed.push(215); s.scoped.push(false); s.ducked.push(false); s.target.push(enemy);
        s.aimErr.push([Math.round((r() - 0.5) * 300), Math.round((r() - 0.5) * 200)]);
        s.impact.push([Math.round((-side_ + (r() - 0.5) * 0.6) * 100), Math.round((-up + (r() - 0.5) * 0.6) * 100)]);
        s.hit.push(r() < (b === 1 ? 0.55 : b < 4 ? 0.4 : 0.22) ? (r() < 0.3 ? 1 : 2) : null);
      }
    }
    tick = tt + 64 * 22;
  }
  return m;
}
