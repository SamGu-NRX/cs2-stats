// TRANSITIONAL: turns a capture-plugin match file (JSON, plugin/schema.ts) into schema v1 tables in
// memory, so the user's existing plugin recordings and converted logs reach the one derive path.
//
// Remove this folder (adapter.ts, schema.ts, decode.ts) and the samples it reads once local demo
// recording is proven (architecture.md, migration step 1: tv_autorecord on the local server, run
// through the extractor) and the user's matches arrive as demos. Nothing else reads plugin files.
//
// What the plugin files cannot provide stays null: view angles, inventories, health before a hit,
// smoke and fire lifetimes, engagements and radar spotting. Rounds the file holds only as totals
// (converted logs before firstFullRound, and rounds the plugin marked partial) are left out, so
// every derived rate covers the rounds with a kill-by-kill log.
import { emptyTable, kindOf, SCHEMA, type MatchTables, type Side, type Table, type TableName } from "../tables";
import type { GrenadeType, MatchFile } from "./schema";

const FLAG = { headshot: 1, wallbang: 2, smoke: 4, blind: 8, noscope: 16, air: 32, suicide: 64, freeze: 128 } as const;
const SIDE: Record<number, Side> = { 2: "T", 3: "CT" };
const THROW_CLASS: Record<GrenadeType | "incgrenade", string> = {
  he: "hegrenade", flash: "flashbang", smoke: "smokegrenade", molotov: "molotov", incgrenade: "incgrenade", decoy: "decoy",
};
const DETONATE: Record<GrenadeType, string> = {
  he: "he_detonate", flash: "flash_detonate", smoke: "smoke_detonate", molotov: "inferno_start", decoy: "decoy_start",
};
const REASON = { elim: (w: Side) => (w === "CT" ? "t_killed" : "ct_killed"), defuse: () => "bomb_defused", bomb: () => "bomb_exploded", time: () => "time_ran_out" };

/** Appends a row; columns not given are null, and a non-nullable column not given is an error. */
function add<N extends TableName>(t: Table<N>, name: N, values: Record<string, unknown>): void {
  const cols = t as unknown as Record<string, unknown[]>;
  for (const c of Object.keys(SCHEMA[name])) {
    const v = values[c];
    if (v === undefined && !kindOf(name, c).endsWith("?") && kindOf(name, c) !== "ss") throw new Error(`plugin adapter: ${name}.${c} has no value`);
    cols[c].push(v === undefined ? (kindOf(name, c) === "ss" ? [] : null) : v);
  }
  t.n++;
}

/** Source engine hit group numbers, named as the demo parser names them. */
const HITGROUP: Record<number, string> = { 1: "head", 2: "chest", 3: "stomach", 4: "left_arm", 5: "right_arm", 6: "left_leg", 7: "right_leg", 8: "neck" };

export function pluginToTables(m: MatchFile): MatchTables {
  const key = m.players.key;
  const human = key[m.human];
  const humanTeam = `Team ${m.players.name[m.human]}`;
  const sideOf = (ri: number, pi: number | null): Side | null => (pi === null ? null : SIDE[m.rounds.side[ri]?.[pi] ?? -1] ?? null);
  const humanStart = SIDE[m.players.startSide[m.human]];
  const teamOf = (pi: number) => (m.players.startSide[pi] === m.players.startSide[m.human] ? humanTeam : "Opponents");
  const partial = new Set(m.recon?.partial ?? []);
  const covered = (ri: number) => ri >= m.firstFullRound && !partial.has(ri) && ri < m.rounds.winSide.length;
  const weapon = (i: number) => m.weapons[i] ?? "unknown";
  const ticks = (ri: number) => {
    const fe = m.rounds.freezeTick[ri];
    const dur = m.rounds.durTicks[ri];
    return { fe, end: fe !== null && dur !== null ? fe + dur : null };
  };

  const t: MatchTables = {
    match: emptyTable("match"), players: emptyTable("players"), rounds: emptyTable("rounds"), player_rounds: emptyTable("player_rounds"),
    kills: emptyTable("kills"), damages: emptyTable("damages"), blinds: emptyTable("blinds"), bomb: emptyTable("bomb"),
    grenade_throws: emptyTable("grenade_throws"), grenade_events: emptyTable("grenade_events"), smokes: emptyTable("smokes"),
    infernos: emptyTable("infernos"), shots: emptyTable("shots"), positions: emptyTable("positions"),
    spotted: null, engagements: null, engagement_ticks: null, purchases: null,
  };

  add(t.match, "match", {
    match_id: m.id, source: "local", map: m.map, tick_rate: m.env.tickrate || 64,
    team_ct_start: humanStart === "CT" ? humanTeam : "Opponents", team_t_start: humanStart === "T" ? humanTeam : "Opponents",
    schema_version: 1, extractor_version: `plugin ${m.env.plugin} via plugin/adapter.ts`,
    convars: JSON.stringify({ mp_maxrounds: m.env.maxrounds ?? 24 }),
    extra: JSON.stringify({
      date: m.startUtc.slice(0, 10), started_at: m.startUtc, duration_s: (Date.parse(m.endUtc) - Date.parse(m.startUtc)) / 1000,
      pov: human, rounds_played: m.rounds.winSide.length,
    }), visibility_status: "no_mapdata",
  });
  key.forEach((id, pi) => add(t.players, "players", { steamid: id, name: m.players.name[pi], team: teamOf(pi), is_bot: m.players.isBot[pi] }));

  for (let ri = 0; ri < m.rounds.winSide.length; ri++) {
    if (!covered(ri)) continue;
    const { fe, end } = ticks(ri);
    if (fe === null || end === null) continue;
    const win = SIDE[m.rounds.winSide[ri] ?? -1] ?? null;
    const how = m.rounds.how[ri];
    const ctIsHuman = sideOf(ri, m.human) === "CT";
    const planter = m.rounds.planter[ri];
    add(t.rounds, "rounds", {
      round: ri + 1, start_tick: fe, freeze_end_tick: fe, end_tick: end, winner_side: win,
      reason: win && how ? REASON[how](win) : null, ct_team: ctIsHuman ? humanTeam : "Opponents", t_team: ctIsHuman ? "Opponents" : humanTeam,
      plant_tick: m.rounds.plantTick[ri], plant_site: m.rounds.bombSite[ri], planter_steamid: planter === null ? null : key[planter],
      defuse_tick: how === "defuse" ? end : null, defuser_steamid: m.rounds.defuser[ri] === null ? null : key[m.rounds.defuser[ri]!],
      explode_tick: how === "bomb" ? end : null,
    });
    if (m.rounds.plantTick[ri] !== null) add(t.bomb, "bomb", { tick: m.rounds.plantTick[ri], round: ri + 1, event: "planted", steamid: planter === null ? null : key[planter], site: m.rounds.bombSite[ri] });
    if (how === "defuse") add(t.bomb, "bomb", { tick: end, round: ri + 1, event: "defused", steamid: m.rounds.defuser[ri] === null ? null : key[m.rounds.defuser[ri]!] });
    if (how === "bomb") add(t.bomb, "bomb", { tick: end, round: ri + 1, event: "exploded" });
    key.forEach((id, pi) => {
      const side = sideOf(ri, pi);
      if (!side) return;
      add(t.player_rounds, "player_rounds", { round: ri + 1, steamid: id, side, money: m.rounds.money[ri][pi], equip_value_game: m.rounds.equip[ri][pi] });
    });
  }

  const k = m.kills;
  for (let i = 0; i < k.ri.length; i++) {
    const ri = k.ri[i];
    if (!covered(ri) || k.flags[i] & FLAG.freeze) continue;
    // A kill or death in a bot's body (takeover) belongs to the bot, as in CS Demo Manager.
    const killer = k.kBody?.[i] ?? k.killer[i];
    const victim = k.vBody?.[i] ?? k.victim[i];
    // CS2 names one assister: the damage assister when there is one, else the flash assister.
    const assister = k.assister[i] ?? k.flashAssister[i];
    const kp = k.kpos[i];
    const vp = k.vpos[i];
    const ks = sideOf(ri, killer);
    const vs = sideOf(ri, victim);
    const suicide = (k.flags[i] & FLAG.suicide) !== 0 || killer === victim;
    add(t.kills, "kills", {
      tick: k.tick[i], round: ri + 1, attacker_steamid: killer === null ? null : key[killer], victim_steamid: key[victim],
      assister_steamid: assister === null ? null : key[assister], assistedflash: k.assister[i] === null && k.flashAssister[i] !== null,
      weapon: weapon(k.weapon[i]), headshot: (k.flags[i] & FLAG.headshot) !== 0, penetrated: k.flags[i] & FLAG.wallbang ? 1 : 0,
      thrusmoke: (k.flags[i] & FLAG.smoke) !== 0, attackerblind: (k.flags[i] & FLAG.blind) !== 0, noscope: (k.flags[i] & FLAG.noscope) !== 0,
      attackerinair: (k.flags[i] & FLAG.air) !== 0, distance: kp && vp ? Math.hypot(kp[0] - vp[0], kp[1] - vp[1], kp[2] - vp[2]) : null,
      a_side: ks, a_x: kp?.[0] ?? null, a_y: kp?.[1] ?? null, a_z: kp?.[2] ?? null,
      a_equip_value_game: killer === null ? null : m.rounds.equip[ri][killer],
      v_side: vs, v_x: vp?.[0] ?? null, v_y: vp?.[1] ?? null, v_z: vp?.[2] ?? null, v_equip_value_game: m.rounds.equip[ri][victim],
      is_suicide: suicide, is_teamkill: !suicide && killer !== null && ks !== null && ks === vs,
    });
  }

  const d = m.damage;
  for (let i = 0; i < d.ri.length; i++) {
    const ri = d.ri[i];
    if (!covered(ri)) continue;
    const a = d.attacker[i];
    const v = d.victim[i];
    add(t.damages, "damages", {
      tick: d.tick[i], round: ri + 1, attacker_steamid: a === null ? null : key[a], victim_steamid: key[v], weapon: weapon(d.weapon[i]),
      // the plugin stores each hit's damage already capped at the victim's health
      dmg_health: d.dmg[i], dmg_health_capped: d.dmg[i], dmg_armor: d.dmgArmor[i], hitgroup: d.hitgroup[i] === null ? null : HITGROUP[d.hitgroup[i]!] ?? "generic",
      a_side: sideOf(ri, a), v_side: sideOf(ri, v), is_team_damage: a !== null && a !== v && sideOf(ri, a) === sideOf(ri, v),
      is_self: a === v, grenade_entity_id: d.nade?.[i] ?? null,
    });
  }

  const b = m.blinds;
  for (let i = 0; i < b.ri.length; i++) {
    const ri = b.ri[i];
    if (!covered(ri)) continue;
    const a = b.attacker[i];
    const v = b.victim[i];
    add(t.blinds, "blinds", {
      tick: b.tick[i], round: ri + 1, attacker_steamid: a === null ? null : key[a], victim_steamid: key[v], duration: b.ms[i] / 1000,
      flash_entity_id: b.flash?.[i] ?? null, is_self: a === v, is_team_flash: a !== null && a !== v && sideOf(ri, a) === sideOf(ri, v), ambiguous: false,
    });
  }

  const g = m.grenades;
  for (let i = 0; i < g.ri.length; i++) {
    const ri = g.ri[i];
    if (!covered(ri)) continue;
    const thrower = g.thrower[i] === null ? null : key[g.thrower[i]!];
    const p = g.pos[i];
    add(t.grenade_events!, "grenade_events", { tick: g.tick[i], round: ri + 1, event: DETONATE[g.type[i]], entity_id: i, steamid: thrower, x: p?.[0] ?? null, y: p?.[1] ?? null, z: p?.[2] ?? null });
    if (p && (g.type[i] === "smoke" || g.type[i] === "molotov")) {
      add(g.type[i] === "smoke" ? t.smokes! : t.infernos!, g.type[i] === "smoke" ? "smokes" : "infernos", { entity_id: i, steamid: thrower, round: ri + 1, start_tick: g.tick[i], x: p[0], y: p[1], z: p[2] });
    }
  }
  // Throws: the plugin's throw log when present (1.0.0), else one throw per detonation.
  const th = m.throws ?? m.grenades;
  for (let i = 0; i < th.ri.length; i++) {
    const ri = th.ri[i];
    if (!covered(ri)) continue;
    const p = th.pos[i];
    const thrower = th.thrower[i];
    add(t.grenade_throws!, "grenade_throws", {
      tick: th.tick[i], round: ri + 1, steamid: thrower === null ? null : key[thrower], weapon: THROW_CLASS[th.type[i]],
      side: sideOf(ri, thrower), x: p?.[0] ?? null, y: p?.[1] ?? null, z: p?.[2] ?? null,
    });
  }

  // Shots exist only for the recording player.
  const s = m.aim.shots;
  for (let i = 0; i < s.ri.length; i++) {
    const ri = s.ri[i];
    if (!covered(ri)) continue;
    add(t.shots!, "shots", { tick: s.tick[i], round: ri + 1, steamid: human, weapon: weapon(s.weapon[i]), side: sideOf(ri, m.human), ducked: s.ducked[i], scoped: s.scoped[i], speed_2d: s.speed[i] });
  }

  const p = m.pos;
  for (let i = 0; i < p.ri.length; i++) {
    const ri = p.ri[i];
    if (!covered(ri)) continue;
    add(t.positions!, "positions", {
      tick: p.tick[i], round: ri + 1, steamid: key[p.pi[i]], side: sideOf(ri, p.pi[i]), x: p.x[i], y: p.y[i], z: p.z[i],
      is_alive: p.alive[i], place: p.place[i] === null ? null : m.places[p.place[i]!] ?? null,
    });
  }
  return t;
}
