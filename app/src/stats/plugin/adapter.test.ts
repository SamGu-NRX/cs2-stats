// The transitional adapter plus derive must reproduce the game's own per-round totals. Converted
// logs (public/samples) carry the game's per-player, per-round kills, deaths, assists, damage and
// headshot kills in rounds.basic, recorded by the server, independent of the event log.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CS2RB } from "../model-params";
import { expect, it } from "vitest";
import { derive } from "../derive";
import { pluginToTables } from "./adapter";
import { decodeMatch } from "./decode";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");

it("kills, deaths and headshot kills match the game's per-round totals in every converted log", async () => {
  const wrong: string[] = [];
  let checked = 0;
  for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"))) {
    const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
    if (!m.rounds.basic) continue;
    const f = derive(pluginToTables(m), CS2RB);
    for (const r of f.pr) {
      const game = m.rounds.basic[f.rounds[r.ri].number - 1]?.[m.players.key.indexOf(f.players[r.pi].id)];
      if (!game) continue;
      checked++;
      const [k, d, , , hs] = game;
      const got = [r.m.kills ?? 0, r.m.deaths ?? 0, r.m.hsKills ?? 0];
      if (got[0] !== k || got[1] !== d || got[2] !== hs) wrong.push(`${file} round ${f.rounds[r.ri].number} ${f.players[r.pi].name}: ${got.join("/")} vs ${k}/${d}/${hs}`);
    }
  }
  expect(checked).toBeGreaterThan(500);
  expect(wrong).toEqual([]);
});
