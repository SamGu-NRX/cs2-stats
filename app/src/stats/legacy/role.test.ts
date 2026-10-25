import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { emptyCounters, type Counters } from "./counters";
import { deriveMatch } from "./derive";
import {
  ANCHOR_MIN_SITE_SHARE, AWPER_MIN_SNIPER_SHARE, deriveRole, ENTRY_MIN_OPENING_ATTEMPTS, LURKER_MIN_TEAM_DISTANCE, placeArea, roleCounts,
  ROLE_MIN_ROUNDS, SUPPORT_MIN_TRADE_ASSIST_SHARE,
} from "./role";
import { MatchBuilder } from "./testing/build";
import { loadPluginMatch, PLUGIN_MATCHES } from "./testing/load";

/** 100 rounds, 100 kills, no assists, nothing else: every flavour below its threshold. */
function base(): Counters {
  const c = emptyCounters();
  Object.assign(c, { rounds: 100, fullRounds: 100, kills: 100, fullKills: 100, openingKills: 10, openingDeaths: 10 });
  return c;
}

describe("role thresholds", () => {
  test(`AWPer from ${AWPER_MIN_SNIPER_SHARE * 100}% sniper kills`, () => {
    const c = base();
    c.sniperKills = 34;
    expect(deriveRole(c).primary).toBe("Rifler");
    c.sniperKills = 35;
    expect(deriveRole(c)).toMatchObject({ primary: "AWPer", flavour: null, label: "AWPer" });
  });
  test(`Entry from ${ENTRY_MIN_OPENING_ATTEMPTS * 100}% opening attempts`, () => {
    const c = base();
    Object.assign(c, { openingKills: 12, openingDeaths: 12 });
    expect(deriveRole(c).flavour).toBeNull();
    c.openingDeaths = 13;
    expect(deriveRole(c)).toMatchObject({ flavour: "Entry", label: "Rifler (Entry)" });
  });
  test(`Support from ${SUPPORT_MIN_TRADE_ASSIST_SHARE * 100}% trade kills and assists`, () => {
    const c = base();
    // (trades + assists) / (kills + assists): (20 + 25) / 125 = 0.36 < 0.45; (35 + 40) / 140 = 0.536
    Object.assign(c, { tradeKills: 20, assists: 25 });
    expect(deriveRole(c).flavour).toBeNull();
    Object.assign(c, { tradeKills: 35, assists: 40 });
    expect(deriveRole(c).flavour).toBe("Support");
  });
  test(`Lurker from ${LURKER_MIN_TEAM_DISTANCE} units from the nearest teammate`, () => {
    const c = base();
    c.role = { tDistN: 10, tDistSum: 10 * (LURKER_MIN_TEAM_DISTANCE - 1), ctSetupRounds: 0, ctAnchorRounds: 0 };
    expect(deriveRole(c).flavour).toBeNull();
    c.role.tDistSum = 10 * LURKER_MIN_TEAM_DISTANCE;
    expect(deriveRole(c).flavour).toBe("Lurker");
  });
  test(`Anchor from ${ANCHOR_MIN_SITE_SHARE * 100}% of CT rounds holding a site`, () => {
    const c = base();
    c.role = { tDistN: 0, tDistSum: 0, ctSetupRounds: 10, ctAnchorRounds: 4 };
    expect(deriveRole(c).flavour).toBeNull();
    c.role.ctAnchorRounds = 5;
    expect(deriveRole(c).flavour).toBe("Anchor");
  });
  test("the flavour with the largest margin wins, and evidence is reported", () => {
    const c = base();
    Object.assign(c, { openingKills: 15, openingDeaths: 15 }); // 0.30 / 0.25 = 1.2
    c.role = { tDistN: 1, tDistSum: 1.5 * LURKER_MIN_TEAM_DISTANCE, ctSetupRounds: 0, ctAnchorRounds: 0 }; // 1.5
    const r = deriveRole(c);
    expect(r.flavour).toBe("Lurker");
    expect(r.evidence).toMatchObject({ rounds: 100, openingAttempts: 0.3, teamDistance: 1.5 * LURKER_MIN_TEAM_DISTANCE, anchorShare: null });
    expect(r.flavours.find((f) => f.flavour === "Entry")!.score).toBeCloseTo(1.2, 12);
  });
  test(`provisional under ${ROLE_MIN_ROUNDS} rounds`, () => {
    const c = base();
    c.fullRounds = ROLE_MIN_ROUNDS - 1;
    expect(deriveRole(c).provisional).toBe(true);
  });
});

describe("position evidence", () => {
  test("dust2 areas", () => {
    expect(["BombsiteA", "LongA", "BombsiteB", "UpperTunnel", "TopMid", "CTSpawn", "TSpawn", null].map((p) => placeArea("de_dust2", p)))
      .toEqual(["A", "A", "B", "B", "Mid", "CT", "Other", "Other"]);
    expect(placeArea("de_mirage", "BombsiteA")).toBeNull();
  });
  test("nearest-teammate distance on T and site holds on CT", () => {
    const b = new MatchBuilder();
    b.m.map = "de_dust2";
    b.m.places = ["BombsiteA", "BombsiteB", "CTSpawn"];
    const p = b.m.pos;
    const at = (pi: number, secs: number, x: number, y: number, place: number | null) => {
      p.ri.push(0); p.tick.push(b.t(0, secs)); p.pi.push(pi); p.x.push(x); p.y.push(y); p.z.push(0); p.place.push(place); p.alive.push(true);
    };
    // T 5, 6, 7 at one second: 5 and 6 are 300 apart, 7 is 2000 from 6
    at(5, 5, 0, 0, null); at(6, 5, 300, 0, null); at(7, 5, 2300, 0, null);
    // CT 0 on B at 15 s, CT 1 on A
    at(0, 15, 0, 0, 1); at(1, 15, 0, 0, 0);
    b.m.rounds.ctSetup[0] = [3, 1, 0, 1, 0];
    const rc = roleCounts(buildCtx(b.build()));
    expect([rc[5].tDistSum, rc[6].tDistSum, rc[7].tDistSum]).toEqual([300, 300, 2000]);
    expect([rc[0].ctAnchorRounds, rc[1].ctAnchorRounds, rc[0].ctSetupRounds]).toEqual([1, 0, 1]);
  });
  test("plugin recordings give every player position evidence and a role", async () => {
    for (const f of PLUGIN_MATCHES.slice(1)) {
      const v = deriveMatch(await loadPluginMatch(f), f);
      for (const p of v.players) {
        expect(p.c.role.tDistN, `${f} ${p.name}`).toBeGreaterThan(0);
        expect(p.c.role.ctSetupRounds).toBeGreaterThan(0);
        expect(p.role.label).toMatch(/^(AWPer|Rifler( \((Entry|Support|Lurker|Anchor)\))?)$/);
      }
    }
  });
});
