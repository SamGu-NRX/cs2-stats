// Career aim's match set against the career set, on one real entry varied by hand.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryOf } from "../../worker/views";
import { poolOf } from "../shell/filters";
import { aimEntries, careerEntries } from "./engine";
import type { MatchEntry } from "./match";

const FILE = "20261024T233426Z_de_dust2_dfa2ac5b.json.gz";
const m = await decodeMatch(readFileSync(path.resolve(import.meta.dirname, "../../../public/samples", FILE)), FILE);
const base = entryOf(`samples/${FILE}`, m.env.plugin ?? "", derive(pluginToTables(m), CS2RB));

it("reads every own match with shots in Career aim, wingman and unfinished included, but no pro demo", () => {
  // fails if Career aim keeps the career filters (wingman, unfinished, thin logs), which left the
  // user's Valve wingman demos and abandoned matches out of his sprays, or lets a pro demo in
  const shots: MatchEntry = { ...base, hasAim: true };
  const two = (team: number) => shots.players.filter((p) => p.team === team).slice(0, 2);
  const wingman: MatchEntry = { ...shots, file: "valve/w/v", match: { ...shots.match, maxRounds: 16, source: "valve" }, players: [...two(0), ...two(1)] };
  const unfinished: MatchEntry = { ...shots, file: "x/unfinished", match: { ...shots.match, complete: false } };
  const pro: MatchEntry = { ...shots, file: "dev/pro" };
  const noShots: MatchEntry = { ...shots, file: "x/none", hasAim: false };
  const all = [shots, wingman, unfinished, pro, noShots];
  expect(aimEntries(all, null).map((e) => e.file)).toEqual([shots.file, "valve/w/v", "x/unfinished"]);
  expect(careerEntries(all, null).map((e) => e.file)).toEqual([shots.file, "x/none"]);
});

it("gives Career aim's Map list and Matches count its own match set", () => {
  // fails if the scope controls on Career aim count the career set, so "All N" and the maps offered
  // leave out the wingman and unfinished matches the page draws
  const shots: MatchEntry = { ...base, hasAim: true };
  const wingman: MatchEntry = { ...shots, file: "valve/w/v", match: { ...shots.match, map: "de_inferno", maxRounds: 16, source: "valve" }, players: shots.players.filter((p) => p.team === 0).slice(0, 2).concat(shots.players.filter((p) => p.team === 1).slice(0, 2)) };
  const all = [shots, wingman];
  expect([poolOf("aim", all, null).length, poolOf("career", all, null).length]).toEqual([2, 1]);
  expect(poolOf("aim", all, "de_inferno").map((e) => e.file)).toEqual(["valve/w/v"]);
});
