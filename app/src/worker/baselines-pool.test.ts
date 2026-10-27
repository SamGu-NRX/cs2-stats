// The pro pool the worker ranks against: the packs folder's baselines.local.json when it is present and
// valid, else the shipped public/baselines.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { choosePool, parseBaselines } from "./baselines-pool";
import { poolLabel } from "./pool-names";

/** 21 rising quantiles, as tools/baselines.ts writes them */
const Q = Array.from({ length: 21 }, (_, i) => i / 10);
const pool = (model: string | undefined, version: unknown = 1, pools: unknown = { all: { both: { kpr: Q, luckScore: null } } }, n: unknown = { all: { both: 552 } }) =>
  JSON.stringify({ version, built: "2026-10-26", source: "s", ...(model === undefined ? {} : { model }), n, pools });
const HLTV = "hltv-0123abcd-pb88f2902";
const CS2RB = "cs2rb-cb22437f-pb88f2902";

describe("choosePool", () => {
  it("takes a valid local pool and never fetches the shipped one", async () => {
    // fails if the shipped file wins over a valid local one
    const shipped = vi.fn(async () => pool(CS2RB));
    const c = await choosePool(pool(HLTV), shipped);
    expect([c.pool, c.b.model, c.localError, c.text]).toEqual(["local", HLTV, null, pool(HLTV)]);
    expect(shipped).not.toHaveBeenCalled();
  });

  it("falls back to the shipped pool without a local file, and says nothing is wrong", async () => {
    const c = await choosePool(null, async () => pool(CS2RB));
    expect([c.pool, c.b.model, c.localError]).toEqual(["shipped", CS2RB, null]);
  });

  it("falls back to the shipped pool when the local file is malformed, and says why", async () => {
    // fails if a broken local file is ranked against, crashes the pool, or is passed over silently
    const cases: [string, RegExp][] = [
      ["{not json", /^baselines\.local\.json: not JSON/],
      [pool(undefined), /^baselines\.local\.json: no model fingerprint$/],
      [pool(HLTV, 2), /^baselines\.local\.json: version is 2, this app reads version 1$/],
      [JSON.stringify({ version: 1, model: HLTV }), /^baselines\.local\.json: no pools$/],
    ];
    for (const [text, why] of cases) {
      const c = await choosePool(text, async () => pool(CS2RB));
      expect(c.pool, text).toBe("shipped");
      expect(c.localError, text).toMatch(why);
    }
  });

  it("falls back when a pool has the right shape but contents a percentile cannot be read from", async () => {
    // fails if a pool with a non-number, an infinite, a short or a falling quantile list, a bad count or
    // no "all" pool is ranked against: its percentiles would be NaN or wrong with no error
    const all = (kpr: unknown) => ({ all: { both: { kpr } } });
    const down = [...Q].reverse();
    const cases: [string, RegExp][] = [
      [pool(HLTV, 1, all(["bad", ...Q.slice(1)])), /all\.both\.kpr\[0\] is "bad", not a finite number$/],
      [pool(HLTV, 1, all(["bad"])), /all\.both\.kpr is not 21 quantiles$/],
      [pool(HLTV, 1, all(Q.slice(1))), /all\.both\.kpr is not 21 quantiles$/],
      [pool(HLTV, 1, all(down)), /all\.both\.kpr decreases at quantile 1$/],
      [pool(HLTV, 1, all({ p50: 1 })), /all\.both\.kpr is not 21 quantiles$/],
      [pool(HLTV, 1, { awper: { both: { kpr: Q } } }, { awper: { both: 9 } }), /no "all" pool$/],
      [pool(HLTV, 1, all(Q), { all: { both: 0 } }), /n\.all\.both is 0, not a positive integer$/],
      [pool(HLTV, 1, all(Q), { all: { both: 2.5 } }), /n\.all\.both is 2\.5, not a positive integer$/],
      [pool(HLTV, 1, { ...all(Q), rifler: { both: { kpr: Q } } }), /pool rifler has no counts in n$/],
      [pool(HLTV, 1, { all: { both: { kpr: Q }, X: { kpr: Q } } }, { all: { both: 1, X: 1 } }), /pool all has an unknown side X$/],
    ];
    // JSON has no NaN or Infinity, but a number past the double range parses as Infinity
    cases.push([pool(HLTV, 1, all(Q)).replace("[0,0.1,", "[0,1e999,"), /all\.both\.kpr\[1\] is Infinity, not a finite number$/]);
    for (const [text, why] of cases) {
      const c = await choosePool(text, async () => pool(CS2RB));
      expect(c.pool, text.slice(0, 120)).toBe("shipped");
      expect(c.localError, text.slice(0, 120)).toMatch(why);
    }
  });

  it("accepts the shipped file and the shape tools/baselines.ts writes", async () => {
    const shipped = readFileSync(path.resolve(import.meta.dirname, "../../public/baselines.json"), "utf8");
    expect(parseBaselines(shipped, "baselines.json").n.all.both).toBeGreaterThan(0);
  });

  it("throws when the shipped pool itself is broken", async () => {
    await expect(choosePool(null, async () => pool(undefined))).rejects.toThrow("baselines.json: no model fingerprint");
    expect(() => parseBaselines("[]", "x")).toThrow("x: version is undefined");
  });

  it("names the pool and its model for Data & settings", () => {
    expect([poolLabel("local", HLTV), poolLabel("shipped", CS2RB)]).toEqual(["Pro pool: local (HLTV model)", "Pro pool: shipped (CS2RB)"]);
  });
});
