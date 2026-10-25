// The UI's shaping of MatchFacts must agree with the engine it reads: the round grid holds every
// kill and death the scoreboard counts, a side's line covers that side's rounds, the running score
// ends at the match score, a thinly covered match shows no rating, and each bundled file is
// labelled with its source.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryLine, playerLine } from "./engine";
import { entryOf, matchModel, roundMatrix, sideOf, type MatchModel } from "./match";
import { sourceOf } from "./sources";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const FILES = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));

async function load(file: string): Promise<MatchModel> {
  const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
  const facts = derive(pluginToTables(m));
  return matchModel(entryOf(`samples/${file}`, m.env.plugin ?? "", facts), facts);
}

describe("match model", async () => {
  const models = await Promise.all(FILES.map(load));

  it("puts every kill and death the scoreboard counts into the round grid", () => {
    for (const v of models) {
      const grid = roundMatrix(v);
      v.players.forEach((p) => {
        const m = playerLine(v, p.pi, "both").summary.m;
        expect(grid[p.pi].reduce((a, c) => a + c.kills.length, 0), `${v.file} ${p.name} kills`).toBe(m.kills);
        expect(grid[p.pi].filter((c) => c.died).length, `${v.file} ${p.name} deaths`).toBe(m.deaths);
      });
    }
  });

  it("rolls a side's line up over the rounds the player spent on that side", () => {
    for (const v of models) {
      const onT = v.rounds.filter((r) => r.pr[v.human] && sideOf(v, r, v.human) === "T").length;
      expect(playerLine(v, v.human, "t").rounds, v.file).toBe(onT);
      expect(playerLine(v, v.human, "ct").rounds, v.file).toBe(v.rounds.filter((r) => r.pr[v.human]).length - onT);
    }
  });

  it("ends the running score at the match score, or has none when early rounds are missing", () => {
    for (const v of models) {
      const last = v.rounds[v.rounds.length - 1];
      if (v.rounds.every((r, ri) => r.number === ri + 1)) expect(last.scoreAfter, v.file).toEqual(v.entry.score);
      else expect(last.scoreAfter, v.file).toBeNull();
    }
  });

  it("shows no rating for a match whose kill log covers under half its rounds", () => {
    const thin = models.filter((v) => v.facts.match.nRounds < v.facts.match.roundsPlayed / 2);
    const full = models.filter((v) => v.facts.match.nRounds === v.facts.match.roundsPlayed);
    expect(thin.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(0);
    for (const v of thin) {
      expect(entryLine(v.entry).rating, v.file).toBeNull();
      expect(playerLine(v, v.human, "both").rating, v.file).toBeNull();
    }
    for (const v of full) expect(entryLine(v.entry).rating, v.file).not.toBeNull();
  });

  it("labels the bundled files by the source that wrote them", () => {
    for (const v of models) expect(sourceOf(v.entry).id, v.file).toBe(v.file.includes("synthetic-demo") ? "synthetic" : "converted");
  });
});
