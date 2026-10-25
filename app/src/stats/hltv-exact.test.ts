// The scoreboard gate (design/architecture.md): the engine's K, D, KAST and ADR against HLTV's per-map
// scoreboards on pro demos. Needs the private data folder (cs2-stats-data: demos/ and hltv/); without
// it the suite is skipped with a message saying so.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hltvMaps, joinHltv } from "../../tools/hltv";
import { DATA_DIR, loadDir, proMapDirs } from "../../tools/node-read";
import { derive } from "./derive";
import { rollup } from "./rollup";

/**
 * 24 of the 83 maps (of 194 joined, 2026-10-25) where every player matches HLTV exactly on K, D and
 * KAST and within 0.5 on ADR. The others mostly miss KAST by one round for one or two players, or come
 * from demos recorded from round 1 live (VALIDATION.md).
 */
const GATE_MAPS = [
  "alliance-vs-nemiga-c7619130/m2-ancient", "astralis-vs-alliance-a7ac677d/m1-inferno",
  "astralis-vs-faze-929f3358/m2-nuke", "b8-vs-fnatic-137fbe4b/m2-mirage", "b8-vs-luminosity-bb35a46a/m1-inferno",
  "b8-vs-luminosity-bb35a46a/m2-mirage", "bbl-vs-ninjas-in-pyjamas-9bd02d7d/inferno",
  "big-vs-fnatic-ab6073b8/m3-mirage", "faze-vs-nemiga-4aab916b/m2-ancient", "fokus-vs-bbl-40fb39ad/m1-nuke",
  "g2-vs-natus-vincere-f3a92631/m2-dust2", "jijiehao-vs-fokus-2fa42bb2/inferno", "k27-vs-nemesis-a6834912/m5-cache",
  "legacy-vs-parivision-fd84447a/m2-inferno", "luminosity-vs-big-bb2b84b1/m1-inferno",
  "ninjas-in-pyjamas-vs-sangal-96396e0d/nuke", "100-thieves-vs-liquid-4f4ef05b/m2-inferno",
  "astralis-vs-fnatic-6163de97/m1-dust2", "betboom-vs-m80-75d909c1/m1-cache", "faze-vs-sangal-96360514/m2-nuke",
  "inner-circle-vs-sangal-e85b61b7/m1-anubis", "luminosity-vs-astralis-1e7f28ad/m3-nuke",
  "nemiga-vs-astralis-f6b2682f/m4-cache", "spirit-vs-shinden-7c8274a7/m2-nuke",
];

const dirs = proMapDirs();
const have = dirs.length > 0 && hltvMaps().length > 0;
if (!have) console.warn(`SKIPPED hltv-exact: no pro tables or HLTV maps under ${DATA_DIR} (set CS2_STATS_DATA)`);

const rel = (dir: string) => path.relative(path.join(DATA_DIR, "demos"), dir).split(path.sep).join("/");

describe.skipIf(!have)("scoreboard against HLTV", () => {
  it("kills match HLTV for every player on every joined map", async () => {
    const wrong: string[] = [];
    for (const dir of dirs) {
      const f = derive(await loadDir(dir, []));
      const j = joinHltv(f);
      if (!j) continue;
      for (const [pi, hp] of j.player) {
        const k = rollup([f], { player: f.players[pi].id }).m.kills;
        if (k !== hp.total.k) wrong.push(`${rel(dir)} ${hp.nick}: ${k} vs ${hp.total.k}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("K, D, KAST and ADR match HLTV on the gate maps", async () => {
    const present = GATE_MAPS.filter((m) => dirs.some((d) => rel(d) === m));
    expect(present.length, "gate maps missing from the data folder").toBe(GATE_MAPS.length);
    const wrong: string[] = [];
    for (const m of present) {
      const f = derive(await loadDir(path.join(DATA_DIR, "demos", m), []));
      const j = joinHltv(f);
      if (!j) { wrong.push(`${m}: no HLTV map joins`); continue; }
      if (j.player.size !== 10) wrong.push(`${m}: ${j.player.size} players joined`);
      for (const [pi, hp] of j.player) {
        const s = rollup([f], { player: f.players[pi].id }).m;
        const kast = Math.round((1000 * s.kast) / s.rounds) / 10;
        // compared as HLTV displays it, to one decimal
        const adr = Math.round((10 * s.dmg) / s.rounds) / 10;
        if (s.kills !== hp.total.k) wrong.push(`${m} ${hp.nick} K ${s.kills} vs ${hp.total.k}`);
        if (s.deaths !== hp.total.d) wrong.push(`${m} ${hp.nick} D ${s.deaths} vs ${hp.total.d}`);
        if (kast !== hp.total.kast) wrong.push(`${m} ${hp.nick} KAST ${kast} vs ${hp.total.kast}`);
        if (Math.abs(adr - hp.total.adr) > 0.5 + 1e-9) wrong.push(`${m} ${hp.nick} ADR ${adr} vs ${hp.total.adr}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
