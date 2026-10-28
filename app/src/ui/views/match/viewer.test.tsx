// @vitest-environment jsdom
// Seeing a pro demo through a picked player (Viewer.tsx, router.ts withViewer, hooks.ts viewerOf): what the address holds.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { viewerOf } from "../../data/hooks";
import type { MatchEntry, MatchModel } from "../../data/match";
import { currentRoute, go, matchHref } from "../../router";
import { ViewerNeeded } from "./Viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRO = "pro/vitality-vs-mouz-1/m1-mirage";
const OTHER = "pro/vitality-vs-mouz-1/m2-inferno";
const STEAMIDS = ["76561190000000011", "76561190000000012", "76561190000000013"];
const v = {
  file: PRO, pro: true, human: null, teamName: { us: "Team Vitality", them: "MOUZ" },
  players: STEAMIDS.map((key, pi) => ({ pi, key, name: `p${pi}`, bot: false, team: pi < 2 ? "us" : "them", isHuman: false })),
} as unknown as MatchModel;

describe("seeing a pro demo through a player", () => {
  it("puts the player's position on the scoreboard in the address, never their SteamID", () => {
    // fails if picking a player writes their SteamID into the URL, where a screenshot or a shared link shows it
    go(matchHref(PRO, "aim"), { instant: true });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<ViewerNeeded v={v} what="their aim" pad />));
    act(() => { host.querySelectorAll("button")[2].click(); });
    expect(currentRoute().query.get("as")).toBe("2");
    expect(STEAMIDS.some((id) => location.href.includes(id))).toBe(false);
    act(() => root.unmount());
  });

  it("keeps the pick on links within the match and drops it on a link to another match", () => {
    // fails if a tab link loses the player the match is seen through, another match opens through them,
    // or the address names the pick twice
    go(matchHref(PRO, "overview", { as: 1 }), { instant: true });
    expect(location.hash.match(/as=/g)).toHaveLength(1);
    expect(new URLSearchParams(matchHref(PRO, "rounds", { round: 4 }).split("?")[1]).get("as")).toBe("1");
    expect(matchHref(OTHER, "overview")).not.toContain("as=");
    expect(matchHref(PRO, "overview", { as: null })).not.toContain("as=");
  });

  it("sees a pro demo through the player at that position, and the user's own match only through the user", () => {
    // fails if ?as= changes whose match the user's own match shows, or if a SteamID in the address is honoured
    const players = STEAMIDS.map((id) => ({ id })) as MatchEntry["players"];
    expect(viewerOf({ you: null, players }, "1")).toBe(STEAMIDS[1]);
    expect(viewerOf({ you: 0, players }, "1")).toBeNull();
    for (const at of [STEAMIDS[1], "3", "-1", "1.0", "", null]) expect(viewerOf({ you: null, players }, at)).toBeNull();
  });
});
