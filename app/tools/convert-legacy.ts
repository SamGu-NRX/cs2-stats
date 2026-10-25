// Converts the two legacy bot matches in ../../fixtures (server snapshots + one event log spanning
// both) into schema-v1 match files in public/samples/, which serve as the app's sample data and as
// test fixtures. Usage: pnpm convert
//
// Rules carried over from fixtures/reference_matchpage.py (verified against the game there):
// - Round result codes: 1 CT elim, 3 defuse, 4 time, 5 T elim, 6 bomb. Unknown codes are an error.
// - The round tally must equal the game's team score.
// - The log can span several matches; it is split where its round counter goes backwards.
//
// Rules found while converting (each one is checked against the snapshot below):
// - round_end carries the round index already advanced (r + 1). Events between round_end and the
//   next round_start (post-round kills, the bomb-explosion death) belong to the round that ended,
//   which is also where the snapshot counts them.
// - A round_end with reason 16 (game commencing) closes warmup; everything up to it is dropped.
// - player_hurt dmg_health is not capped. Damage is the victim's HP drop per hit (lethal hits capped
//   at the HP left), which reproduces the snapshot's per-round damage exactly for the 18:09 match.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { emptyTables, KILL_FLAG, type GrenadeType, type KillState, type MatchFile, type RoundHow, type Side, type Vec3 } from "../src/stats/schema";
import { PRICE, weaponClass } from "../src/stats/weapons";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../fixtures");
const OUT = path.resolve(here, "../public/samples");
const HALF = 12;

// The brief gave firstFullRound 14 for the 17:14 match. The log has no freeze_end for round
// index 14 and starts after part of its damage (Rock: 100 of 221 logged), so round 14 is not
// complete; the first complete round is index 15. The converter derives the value from the log and
// prints both when they differ.
const MATCHES = [
  { snapshot: "de_dust2_20261024_180954_match_end.json", briefFirstFullRound: 0 },
  { snapshot: "de_dust2_20261024_171429_match_end.json", briefFirstFullRound: 14 },
];

// ---- legacy formats
interface LPlayer { Slot: number; PlayerName: string; IsBot: boolean; Team: number; Hp: number; Pos: [number, number, number]; Money: number; Weapon: string | null }
interface Ev { T: string; Tick: number; Time: number; Round: number; Data: any } // eslint-disable-line @typescript-eslint/no-explicit-any
interface SnapRound { Kills: number; Deaths: number; Assists: number; Damage: number; HeadShotKills: number; EquipmentValue: number; LiveTime: number }
interface SnapPlayer { PlayerName: string; SteamID: string; IsBot: boolean; Team: number; Rounds: SnapRound[]; Match: Record<string, number> }
interface Snapshot { Reason: string; Time: string; Map: string; RoundsPlayed: number; RoundResults: number[]; AliveCT: number[]; AliveT: number[]; Teams: { TeamNum: number; Score: number }[]; Players: SnapPlayer[] }

const ROUND_RESULT: Record<number, [Side, RoundHow]> = { 1: [3, "elim"], 3: [3, "defuse"], 4: [3, "time"], 5: [2, "elim"], 6: [2, "bomb"] };
// CS2 RoundEndReason values seen in the log, for cross-checking the snapshot codes.
const END_REASON: Record<number, RoundHow> = { 1: "bomb", 7: "defuse", 8: "elim", 9: "elim", 12: "time" };
const GAME_COMMENCING = 16;

function fail(msg: string): never {
  throw new Error(`convert-legacy: ${msg}`);
}

const strip = (w: string) => w.replace(/^weapon_/, "").replace(/^item_/, "");
const v3 = (p: [number, number, number] | undefined | null): Vec3 | null => (p ? [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])] : null);

function loadEvents(): Ev[][] {
  const lines = readFileSync(path.join(FIXTURES, "events_two_matches.jsonl"), "utf8").split("\n");
  const segments: Ev[][] = [];
  let seg: Ev[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Ev;
    if (seg.length && e.Round < seg[seg.length - 1].Round) {
      segments.push(seg);
      seg = [];
    }
    seg.push(e);
  }
  segments.push(seg);
  return segments;
}

/** Side a player had in round ri, given the side they are on at the end (MR12 halves swap). */
function sideInRound(ri: number, n: number, sideNow: Side): Side {
  const curHalf = Math.floor((n - 1) / HALF);
  return (curHalf - Math.floor(ri / HALF)) % 2 === 0 ? sideNow : ((5 - sideNow) as Side);
}

function compactUtc(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Equipment reconstruction for bots, whose snapshot equipment value reads 0. */
class Inventory {
  primary = 0; secondary = 200; armor = 0; nades = 0; kit = 0; known = false;
  reset() { this.primary = 0; this.secondary = 200; this.armor = 0; this.nades = 0; this.kit = 0; this.known = true; }
  buy(item: string) {
    const price = PRICE[item];
    if (price === undefined) fail(`no price for bought item "${item}"`);
    if (item === "assaultsuit") this.armor = 1000;
    else if (item === "kevlar") this.armor = Math.max(this.armor, 650);
    else if (item === "defuser") this.kit = 400;
    else if (weaponClass(item) === "pistol") this.secondary = price;
    else if (weaponClass(item) === "grenade" || item === "taser") this.nades += price;
    else this.primary = price;
  }
  thrown(type: GrenadeType) {
    const price = { he: 300, flash: 200, smoke: 300, molotov: 400, decoy: 50 }[type];
    this.nades = Math.max(0, this.nades - price);
  }
  value(): number | null {
    return this.known ? this.primary + this.secondary + this.armor + this.nades + this.kit : null;
  }
}

function convert(snapName: string, briefFFR: number, segments: Ev[][]): { file: MatchFile; name: string } {
  // Human SteamIDs exceed 2^53, so they are quoted before parsing to keep every digit.
  const text = readFileSync(path.join(FIXTURES, snapName), "utf8").replace(/"SteamID":\s*(\d+)/g, '"SteamID":"$1"');
  const snap = JSON.parse(text) as Snapshot;
  const n = snap.RoundsPlayed;
  if (snap.Reason !== "match_end") fail(`${snapName}: snapshot reason is ${snap.Reason}, expected match_end`);

  // ---- pick the log segment that ends on this match's last round (as the reference does)
  const fits = segments.filter((s) => [n - 1, n].includes(Math.max(...s.map((e) => e.Round))));
  fits.sort((a, b) => Math.min(...a.map((e) => e.Round)) - Math.min(...b.map((e) => e.Round)));
  if (!fits.length) fail(`${snapName}: no log segment ends on round ${n}`);
  let evs = fits[0];
  const commence = evs.findIndex((e) => e.T === "round_end" && e.Data.Reason === GAME_COMMENCING);
  const commenceTime = commence >= 0 ? evs[commence].Time : null;
  if (commence >= 0) evs = evs.slice(commence + 1);

  // ---- assign every event to a round
  const tagged: { ri: number; e: Ev }[] = [];
  let post = false;
  let ended = -1;
  for (const e of evs) {
    let ri: number;
    if (e.T === "round_end") { ri = e.Round - 1; post = true; ended = ri; }
    else if (e.T === "round_start") { ri = e.Round; post = false; }
    else ri = post ? ended : e.Round;
    if (ri >= 0 && ri < n) tagged.push({ ri, e });
  }
  const freezeEnd = new Map<number, Ev>();
  const roundEnd = new Map<number, Ev>();
  for (const { ri, e } of tagged) {
    if (e.T === "freeze_end") freezeEnd.set(ri, e);
    if (e.T === "round_end") roundEnd.set(ri, e);
  }
  let ffr = n;
  while (ffr > 0 && freezeEnd.has(ffr - 1) && roundEnd.has(ffr - 1)) ffr--;
  if (ffr !== briefFFR) {
    console.warn(`  ${snapName}: firstFullRound from the log is ${ffr}; the brief said ${briefFFR}. Using ${ffr}.`);
  }
  const live = tagged.filter((t) => t.ri >= ffr);

  // ---- players
  const sp = snap.Players.filter((p) => p.Team === 2 || p.Team === 3);
  const pi = new Map(sp.map((p, i) => [p.PlayerName, i]));
  const P = (ref: LPlayer | null | undefined): number | null => {
    if (!ref) return null;
    const i = pi.get(ref.PlayerName);
    if (i === undefined) fail(`${snapName}: log player "${ref.PlayerName}" is not in the snapshot`);
    return i;
  };
  const human = sp.findIndex((p) => !p.IsBot);
  if (human < 0) fail(`${snapName}: no human player`);

  const side: (Side | null)[][] = [];
  for (let ri = 0; ri < n; ri++) {
    const fe = freezeEnd.get(ri);
    const row = sp.map((p) => sideInRound(ri, n, p.Team as Side)) as (Side | null)[];
    if (fe && ri >= ffr) for (const lp of fe.Data as LPlayer[]) row[P(lp)!] = lp.Team as Side;
    side.push(row);
  }

  // ---- round results, checked against the log where it has the round
  const winSide: Side[] = [];
  const how: RoundHow[] = [];
  for (let ri = 0; ri < n; ri++) {
    const res = ROUND_RESULT[snap.RoundResults[ri]];
    if (!res) fail(`${snapName}: unknown round result code ${snap.RoundResults[ri]} in round ${ri + 1}`);
    const re = roundEnd.get(ri);
    if (re && (re.Data.Winner !== res[0] || END_REASON[re.Data.Reason] !== res[1])) {
      fail(`${snapName}: round ${ri + 1} snapshot says ${res} but round_end says winner ${re.Data.Winner} reason ${re.Data.Reason}`);
    }
    winSide.push(res[0]);
    how.push(res[1]);
  }

  // ---- score [T, CT] before each round; the final tally must equal the game's team score
  const humanTeamNow = sp[human].Team as Side;
  let us = 0, them = 0;
  const score: [number, number][] = [];
  for (let ri = 0; ri < n; ri++) {
    const hs = side[ri][human]!;
    score.push(hs === 2 ? [us, them] : [them, us]);
    if (winSide[ri] === hs) us++; else them++;
  }
  const teamScore = new Map(snap.Teams.map((t) => [t.TeamNum, t.Score]));
  if (teamScore.get(humanTeamNow) !== us || teamScore.get((5 - humanTeamNow) as Side) !== them) {
    fail(`${snapName}: round tally ${us}-${them} disagrees with the game's score ${teamScore.get(humanTeamNow)}-${teamScore.get((5 - humanTeamNow) as Side)}`);
  }

  // ---- tables
  const weapons: string[] = [];
  const W = (name: string) => {
    let i = weapons.indexOf(name);
    if (i < 0) { i = weapons.length; weapons.push(name); }
    return i;
  };
  const t = emptyTables();
  const rounds: MatchFile["rounds"] = {
    winSide, how, score, side,
    freezeTick: [], durTicks: [], bombSite: [], plantTick: [], planter: [], defuser: [], ctSetup: [], equip: [], money: [],
    basic: [], lite: [], aliveEnd: [],
  };

  const inv = sp.map(() => new Inventory());
  const modelHuman: { ri: number; model: number | null; game: number }[] = [];
  for (let ri = 0; ri < n; ri++) {
    const fe = freezeEnd.get(ri);
    const re = roundEnd.get(ri);
    const logged = ri >= ffr && fe && re;
    rounds.freezeTick.push(logged ? fe.Tick : null);
    rounds.durTicks.push(logged ? re.Tick - fe.Tick : null);
    rounds.ctSetup.push(null); // needs place names, which the legacy log does not have
    // The snapshot has the game's own per-round totals for every round, including rounds before the
    // kill log starts; those rounds are "lite": totals only.
    rounds.basic!.push(sp.map((p) => { const r = p.Rounds[ri]; return [r.Kills, r.Deaths, r.Assists, r.Damage, r.HeadShotKills]; }));
    rounds.lite!.push(ri < ffr);
    rounds.aliveEnd!.push([snap.AliveCT[ri], snap.AliveT[ri]]);
    const evR = logged ? live.filter((x) => x.ri === ri).map((x) => x.e) : [];
    const plant = evR.find((e) => e.T === "plant");
    const defuse = evR.find((e) => e.T === "defuse");
    // de_dust2 only: site entity ids are not in the log, but A is the east site (x > 0), B the west.
    const site = plant ? (snap.Map === "de_dust2" ? (plant.Data.Player.Pos[0] > 0 ? "A" : "B") : null) : null;
    rounds.bombSite.push(site);
    rounds.plantTick.push(plant ? plant.Tick : null);
    rounds.planter.push(plant ? P(plant.Data.Player) : null);
    rounds.defuser.push(defuse ? P(defuse.Data.Player) : null);

    // equipment: the human's comes from the snapshot; bots' is reconstructed from their buys
    const halfStart = ri % HALF === 0;
    sp.forEach((p, i) => {
      const diedLast = ri > 0 && p.Rounds[ri - 1].Deaths > 0;
      if (halfStart || diedLast) inv[i].reset();
      else if (ri === ffr) inv[i].known = false; // carried gear from an unlogged round is unknown
    });
    if (!logged) {
      rounds.equip.push(sp.map((p, i) => (i === human ? p.Rounds[ri].EquipmentValue : null)));
      rounds.money.push(sp.map(() => null));
      continue;
    }
    const buys = evR.filter((e) => e.T === "buy");
    for (const b of buys) if (b.Tick <= fe.Tick) inv[P(b.Data.Player)!].buy(strip(b.Data.Weapon));
    const equipRow = sp.map((p, i) => (i === human ? p.Rounds[ri].EquipmentValue : inv[i].value()));
    modelHuman.push({ ri, model: inv[human].value(), game: sp[human].Rounds[ri].EquipmentValue });
    rounds.equip.push(equipRow);
    const moneyRow: (number | null)[] = sp.map(() => null);
    for (const lp of fe.Data as LPlayer[]) moneyRow[P(lp)!] = lp.Money;
    rounds.money.push(moneyRow);
    for (const b of buys) if (b.Tick > fe.Tick) inv[P(b.Data.Player)!].buy(strip(b.Data.Weapon));

    // ---- walk the round in order: HP, alive, bomb state, kills, damage, blinds, grenades
    const hp = new Map<number, number>();
    const alive = new Set<number>();
    for (const lp of fe.Data as LPlayer[]) { hp.set(P(lp)!, lp.Hp); if (lp.Hp > 0) alive.add(P(lp)!); }
    let plantTick: number | null = null;
    const sideOf = (i: number) => side[ri][i];
    const sum = (s: Side, f: (i: number) => number | null) => {
      let total = 0;
      for (const i of alive) if (sideOf(i) === s) { const v = f(i); if (v === null) return null; total += v; }
      return total;
    };
    for (const e of evR) {
      const d = e.Data;
      if (e.T === "plant") plantTick = e.Tick;
      else if (e.T === "hurt") {
        const v = P(d.Victim)!;
        const a = P(d.Attacker);
        const before = hp.get(v) ?? d.Health + d.DmgHealth;
        const dmg = d.Health === 0 ? Math.min(d.DmgHealth, before) : before - d.Health;
        hp.set(v, d.Health);
        if (a !== null && a !== v) {
          t.damage.ri.push(ri); t.damage.tick.push(e.Tick); t.damage.attacker.push(a); t.damage.victim.push(v);
          t.damage.dmg.push(dmg); t.damage.dmgArmor.push(d.DmgArmor); t.damage.weapon.push(W(d.Weapon || "world"));
          t.damage.hitgroup.push(d.Hitgroup ?? null);
        }
      } else if (e.T === "death") {
        const v = P(d.Victim)!;
        const a = P(d.Attacker);
        const killer = a === v ? null : a; // world deaths and suicides have no killer
        const state: KillState = [
          [...alive].filter((i) => sideOf(i) === 3).length,
          [...alive].filter((i) => sideOf(i) === 2).length,
          sum(3, (i) => hp.get(i) ?? 0)!, sum(2, (i) => hp.get(i) ?? 0)!,
          sum(3, (i) => equipRow[i]), sum(2, (i) => equipRow[i]),
          plantTick !== null ? 1 : 0, plantTick !== null ? e.Tick - plantTick : null,
        ];
        const assister = P(d.Assister);
        let flags = 0;
        if (d.Headshot) flags |= KILL_FLAG.headshot;
        if (d.Penetrated > 0) flags |= KILL_FLAG.wallbang;
        if (d.Thrusmoke) flags |= KILL_FLAG.smoke;
        if (d.Attackerblind) flags |= KILL_FLAG.blind;
        if (d.Noscope) flags |= KILL_FLAG.noscope;
        const k = t.kills;
        k.ri.push(ri); k.tick.push(e.Tick); k.killer.push(killer); k.victim.push(v);
        // CS2 reports a flash assist through the assister slot; it also counts as an assist.
        k.assister.push(assister); k.flashAssister.push(d.Assistedflash ? assister : null);
        k.weapon.push(W(d.Weapon || "world")); k.flags.push(flags);
        k.kpos.push(killer !== null ? v3(d.Attacker.Pos) : null); k.vpos.push(v3(d.Victim.Pos)); k.state.push(state);
        alive.delete(v);
        hp.set(v, 0);
      } else if (e.T === "blind") {
        t.blinds.ri.push(ri); t.blinds.tick.push(e.Tick); t.blinds.attacker.push(P(d.Attacker));
        t.blinds.victim.push(P(d.Victim)!); t.blinds.ms.push(Math.round(d.BlindDuration * 1000));
      } else if (e.T === "he" || e.T === "flash" || e.T === "smoke" || e.T === "inferno") {
        // pos is the detonation point. inferno events carry no thrower in the legacy log.
        const type: GrenadeType = e.T === "inferno" ? "molotov" : (e.T as GrenadeType);
        const thrower = e.T === "inferno" ? null : P(d.Thrower);
        t.grenades.ri.push(ri); t.grenades.tick.push(e.Tick); t.grenades.thrower.push(thrower);
        t.grenades.type.push(type); t.grenades.pos.push(v3(d.Pos));
        if (thrower !== null) inv[thrower].thrown(type);
      }
    }

    // ---- cross-check the round against the game's own per-round stats
    sp.forEach((p, i) => {
      const kills = t.kills.ri.filter((r, j) => r === ri && t.kills.killer[j] === i && side[ri][t.kills.victim[j]] !== side[ri][i]).length;
      const deaths = t.kills.ri.filter((r, j) => r === ri && t.kills.victim[j] === i).length;
      if (kills !== p.Rounds[ri].Kills || deaths !== p.Rounds[ri].Deaths) {
        fail(`${snapName}: round ${ri + 1} ${p.PlayerName} has ${kills}-${deaths} in the log, snapshot says ${p.Rounds[ri].Kills}-${p.Rounds[ri].Deaths}`);
      }
      const dmg = t.damage.ri.reduce((s, r, j) => (r === ri && t.damage.attacker[j] === i && side[ri][t.damage.victim[j]] !== side[ri][i] ? s + t.damage.dmg[j] : s), 0);
      if (Math.abs(dmg - p.Rounds[ri].Damage) > 2) {
        fail(`${snapName}: round ${ri + 1} ${p.PlayerName} damage ${dmg} in the log, snapshot says ${p.Rounds[ri].Damage}`);
      }
    });
  }

  // ---- times: the snapshot is written at match end
  const endUtc = new Date(snap.Time).toISOString();
  const lastEnd = roundEnd.get(n - 1);
  let startMs: number;
  if (commenceTime !== null && lastEnd) startMs = Date.parse(endUtc) - (lastEnd.Time - commenceTime) * 1000;
  else {
    // The log starts mid-match: estimate from per-round live time plus about 20 s of freeze time
    // and round restart delay per round. Only orders the match list; no stat uses it.
    const secs = Array.from({ length: n }, (_, ri) => Math.max(...sp.map((p) => p.Rounds[ri].LiveTime)) + 20).reduce((a, b) => a + b, 0);
    startMs = Date.parse(endUtc) - secs * 1000;
  }
  const startUtc = new Date(Math.round(startMs / 1000) * 1000).toISOString();
  const id = createHash("sha256").update(snapName).digest("hex").slice(0, 32);

  const file: MatchFile = {
    v: 1, id, map: snap.Map, startUtc, endUtc, status: "complete",
    env: { plugin: "legacy-convert", cssharp: null, game: "1.41.9.2", tickrate: 64, maxrounds: 24, botDifficulty: null },
    firstFullRound: ffr, weapons, places: [], human,
    players: {
      key: sp.map((p) => (p.IsBot ? `B:${p.PlayerName}` : p.SteamID)),
      name: sp.map((p) => p.PlayerName), isBot: sp.map((p) => p.IsBot), startSide: sp.map((_, i) => side[0][i]!),
    },
    rounds, ...t,
  };

  const errs = modelHuman.filter((x) => x.model !== null);
  const mae = errs.reduce((s, x) => s + Math.abs(x.model! - x.game), 0) / Math.max(1, errs.length);
  console.log(`  ${snapName}: rounds ${n}, logged ${n - ffr}, kills ${t.kills.ri.length}, damage rows ${t.damage.ri.length}, score ${us}-${them}`);
  console.log(`    bot equipment model vs the human's real values: mean abs error $${mae.toFixed(0)} over ${errs.length} rounds`);
  return { file, name: `${compactUtc(startUtc)}_${snap.Map}_${id.slice(0, 8)}.json.gz` };
}

function main() {
  const segments = loadEvents();
  mkdirSync(OUT, { recursive: true });
  const names: string[] = [];
  for (const m of MATCHES) {
    const { file, name } = convert(m.snapshot, m.briefFirstFullRound, segments);
    writeFileSync(path.join(OUT, name), gzipSync(JSON.stringify(file), { level: 9 }));
    names.push(name);
    console.log(`    wrote public/samples/${name}`);
  }
  writeFileSync(path.join(OUT, "index.json"), JSON.stringify(names.sort().reverse(), null, 1) + "\n");
}

main();
