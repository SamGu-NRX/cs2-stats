// The rules of "Hide personal info" one at a time (privacy.ts). privacy.test.tsx in views/ checks
// that every page applies them.
import { describe, expect, it } from "vitest";
import type { PlayerInfo } from "../../stats/facts";
import { hidePlayers, hideText, privacySwitch } from "./privacy";

const ID = "76561190000000099";

describe("privacySwitch", () => {
  it("is on for VITE_PRIVACY=1 or privacy=1 in the query, and nothing else", () => {
    expect(privacySwitch("1", "")).toBe(true);
    expect(privacySwitch(undefined, "?privacy=1")).toBe(true);
    expect(privacySwitch(undefined, "?demo=synthetic&privacy=1")).toBe(true);
    expect(privacySwitch(undefined, "")).toBe(false);
    expect(privacySwitch("0", "?privacy=0")).toBe(false);
    expect(privacySwitch("true", "?privacy")).toBe(false);
  });
});

describe("hidePlayers", () => {
  const p = (name: string, team: 0 | 1 | null, bot = false, id = name): PlayerInfo => ({ id, name, team, bot });
  // a Valve 5v5 seen from team 1, with a bot and a player who never had a side
  const players = [p("Mate A", 1), p("Foe A", 0), p("Me", 1, false, ID), p("Rip", 0, true), p("Foe B", 0), p("Mate B", 1), p("Spectator", null)];

  it("names you You, other humans by team in file order, and keeps bots and every id", () => {
    const out = hidePlayers(players, { you: 2, usTeam: 1, pro: false });
    expect(out.map((x) => x.name)).toEqual(["Teammate 1", "Opponent 1", "You", "Rip", "Opponent 2", "Teammate 2", "Player 1"]);
    expect(out.map((x) => x.id)).toEqual(players.map((x) => x.id));
    expect(out.map((x) => [x.team, x.bot])).toEqual(players.map((x) => [x.team, x.bot]));
  });

  it("keeps every name in a pro demo", () => {
    expect(hidePlayers(players, { you: 2, usTeam: 1, pro: true })).toBe(players);
  });
});

describe("hideText", () => {
  const user = ["C:", "Users", "Ann Example"].join("\\");
  it.each([
    [`ENOENT: no such file or directory, scandir '${user}\\AppData\\Roaming\\BotMatchStats\\matches'`, "ENOENT: no such file or directory, scandir '<path>'"],
    [`failed to read ${user}\\My Demos\\match.json: access denied`, "failed to read <path>: access denied"],
    [`"${user.replaceAll("\\", "\\\\")}\\\\x.json" missing`, `"<path>" missing`],
    ["D:/Games/CS2 Demos/a.dem is gone", "<path> is gone"],
    ["\\\\nas\\share\\cs2\\x.dem (os error 5)", "<path> (os error 5)"],
    ["cannot open /home/ann/cs2/valve/x.parquet, retrying", "cannot open <path>, retrying"],
    [`the recording player (match pov ${ID}) is not among the players`, "the recording player (match pov <SteamID>) is not among the players"],
    ["STEAM_1:0:12345 and [U:1:24691]", "<SteamID> and <SteamID>"],
    [`see https://steamcommunity.com/profiles/${ID}/ for more`, "see <Steam profile> for more"],
  ])("hides %s", (raw, hidden) => {
    expect(hideText(raw)).toBe(hidden);
  });

  it.each([
    "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz",
    "valve/match730_003/v1",
    "dev/pro-demo",
    String.raw`%APPDATA%\BotMatchStats\packs`,
    "http://localhost:1420/__matches/list",
    "Rating 3.0 over 12 rated matches, 3/4 won and/or tied",
    "76561190000",
  ])("leaves %s", (s) => {
    expect(hideText(s)).toBe(s);
  });
});
