// The scoreboard gate (design/architecture.md): the engine's K, D, KAST and ADR against HLTV's per-map
// scoreboards on pinned pro demos. Needs the private data folder (cs2-stats-data: demos/ and hltv/);
// without it the suite is skipped with a message saying so. Kills on every joined map: pnpm hltv-check.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hltvMaps, hltvRound1, joinHltv } from "../../tools/hltv";
import { DATA_DIR, loadDir, mapTablesDir, WINPROB } from "../../tools/node-read";
import { derive } from "./derive";
import { rollup } from "./rollup";

/**
 * 24 maps, three or four per map pool map, where every player matched HLTV exactly on K, D and KAST
 * and within 0.5 on ADR on the 395-map run of pnpm hltv-check (VALIDATION.md); re-pinned 2026-10-25
 * after the extractor's re-extraction moved the earlier set.
 */
const GATE_MAPS = [
  "1win-vs-aurora-5f1d137b/m1-dust2",
  "9z-vs-falcons-a51ade09/m1-nuke",
  "alka-vs-los-ninos-ce861ea6/m2-dust2",
  "alliance-vs-nemiga-61b3ab80/m2-ancient",
  "astral-vs-iberian-soul-e6e8350e/m1-cache",
  "astralis-vs-alliance-2029146f/m1-inferno",
  "astralis-vs-big-88e4546b/m2-inferno",
  "astralis-vs-big-88e4546b/m3-mirage",
  "astralis-vs-faze-b6d2f9f9/m2-nuke",
  "astralis-vs-fnatic-21d24cef/m1-dust2",
  "astralis-vs-fnatic-21d24cef/m2-ancient",
  "b8-vs-fnatic-df598fbd/m2-mirage",
  "b8-vs-luminosity-eeae43e3/m1-inferno",
  "b8-vs-luminosity-eeae43e3/m2-mirage",
  "baks-vs-illyrians-e9d7f468/m3-ancient",
  "baks-vs-lfo-10-1af60588/m1-mirage",
  "bbl-vs-luminosity-07de06fe/m1-nuke",
  "bbl-vs-ninjas-in-pyjamas-6d468c01/inferno",
  "bc-game-vs-bbl-cca68dd6/m2-cache",
  "borracherios-vs-quintessencia-3983feb3/m1-anubis",
  "eternal-fire-vs-jijiehao-3b8492f2/m3-anubis",
  "faze-vs-sangal-504c00b2/m2-nuke",
  "faze-vs-sangal-504c00b2/m3-cache",
  "jijiehao-vs-100-thieves-178ef7bd/m3-anubis",
];

// The extraction pipeline rewrites the data folder while it runs, so the test reads only the pinned
// gate maps; one that is absent or has no tables yet is skipped by name.
const gateDir = (m: string) => { const r = mapTablesDir(path.join(DATA_DIR, "demos", m)); return r && "dir" in r ? r.dir : null; };
const present = GATE_MAPS.filter((m) => gateDir(m) !== null);
const absent = GATE_MAPS.filter((m) => !present.includes(m));
const have = present.length > 0 && hltvMaps().length > 0;
if (!have) console.warn(`SKIPPED hltv-exact: no gate maps or HLTV maps under ${DATA_DIR} (set CS2_STATS_DATA)`);
else if (absent.length) console.warn(`SKIPPED gate maps not in the data folder: ${absent.join(", ")}`);

describe.skipIf(!have)("scoreboard against HLTV", () => {
  it("K, D, KAST and ADR match HLTV on the gate maps", async () => {
    const wrong: string[] = [];
    for (const m of present) {
      const f = derive(await loadDir(gateDir(m)!, []), WINPROB);
      const j = joinHltv(f);
      if (!j) { wrong.push(`${m}: no HLTV map joins`); continue; }
      if (j.player.size !== 10) wrong.push(`${m}: ${j.player.size} players joined`);
      for (const [pi, hp] of j.player) {
        const s = rollup([f], { player: f.players[pi].id }).m;
        const kast = hltvRound1((100 * s.kast) / s.rounds);
        // compared as HLTV displays it, to one decimal
        const adr = hltvRound1(s.dmg / s.rounds);
        if (s.kills !== hp.total.k) wrong.push(`${m} ${hp.nick} K ${s.kills} vs ${hp.total.k}`);
        if (s.deaths !== hp.total.d) wrong.push(`${m} ${hp.nick} D ${s.deaths} vs ${hp.total.d}`);
        if (kast !== hp.total.kast) wrong.push(`${m} ${hp.nick} KAST ${kast} vs ${hp.total.kast}`);
        if (Math.abs(adr - hp.total.adr) > 0.5 + 1e-9) wrong.push(`${m} ${hp.nick} ADR ${adr} vs ${hp.total.adr}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
