import { describe, expect, it } from "vitest";
import type { PlayerInfo } from "../src/stats/facts";
import { acceptedJoins, joinFromRecord, joinLabel, type DemoJoin } from "./demo-joins";
import type { HltvLine, HltvMap, HltvPlayer } from "./hltv";

const line: HltvLine = {
  k: 0, hs: 0, a: 0, fa: 0, d: 0, td: 0, kast: 0, adr: 0, opK: 0, opD: 0, mks: 0, clutches: 0, swing: 0, rating: 0,
  eK: 0, eD: 0, eKast: 0, eAdr: 0,
};
const hp = (nick: string, pid: string, team: string): HltvPlayer => ({ nick, pid, team, total: line, ct: null, t: null });
const page: HltvMap = {
  file: "ocs_map_9.json", map: "de_nuke", date: "2026-04-01", teams: [["Alpha", 13], ["Beta", 9]],
  players: [hp("device", "7592", "Alpha"), hp("other", "100", "Alpha"), hp("rival", "200", "Beta")],
  equip: [], swingPerRound: new Map(),
};
const player = (id: string, name: string, team: PlayerInfo["team"]): PlayerInfo => ({ id, name, team, bot: false });

describe("joins from join_demos.py", () => {
  it("pairs a player whose in-game name differs from HLTV's by the SteamID the join recorded", () => {
    // Review of the refit on OpenCS2 maps: the dump paired players by name (at least 7 of 10 shared), so the
    // 1,042 renamed players and every map joined by HLTV match id were missing from the swing fit's rows.
    const rec: DemoJoin = {
      demo: "demos\\a-vs-b-opencs2-9-m1\\m1-nuke", hltv: "ocs_map_9.json",
      players: { "11": { hltv: "device", pid: "7592" }, "12": { hltv: "other", pid: "100" }, "21": { hltv: "rival", pid: "200" } },
    };
    const players = [player("21", "rival", 0), player("11", "dev1ce_2026", 1), player("12", "other", 1), player("99", "coach", null)];
    const j = joinFromRecord(players, rec, page);
    expect([...j.player].map(([i, p]) => [players[i].name, p.nick])).toEqual([["rival", "rival"], ["dev1ce_2026", "device"], ["other", "other"]]);
    // demo team 0 (started CT) is HLTV's Beta, team 1 Alpha
    expect(j.team).toEqual([1, 0]);
    expect(j.unmatched).toEqual([]);
  });

  it("refuses a record whose paired id is not on its page", () => {
    const rec: DemoJoin = { demo: "demos\\x\\m1-nuke", hltv: "ocs_map_9.json", players: { "11": { hltv: "ghost", pid: "999" } } };
    expect(() => joinFromRecord([player("11", "ghost", 0)], rec, page)).toThrow("HLTV player id 999, who is not on ocs_map_9.json");
  });

  it("refuses a join file written before the join recorded its pairing", () => {
    const old = { accepted: [{ demo: "demos\\x\\m1-nuke", hltv: "map_1.json" }] };
    expect(() => acceptedJoins(old)).toThrow("records no player pairing; run join_demos.py again");
  });

  it("keys a record by the label mapLabel gives its tables folder", () => {
    expect(joinLabel("demos\\a-vs-b-1234\\m2-mirage-p1")).toBe("a-vs-b-1234/m2-mirage-p1");
    expect(() => joinLabel("other\\a\\m1")).toThrow("is not demos");
  });
});
