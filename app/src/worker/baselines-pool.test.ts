// The pro pool the worker ranks against: the packs folder's baselines.local.json when it is present and
// valid, else the shipped public/baselines.json.
import { describe, expect, it, vi } from "vitest";
import { choosePool, parseBaselines, poolLabel } from "./baselines-pool";

const pool = (model: string | undefined, version: unknown = 1) =>
  JSON.stringify({ version, built: "2026-10-26", source: "s", ...(model === undefined ? {} : { model }), n: { all: { both: 1 } }, pools: { all: {} } });
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

  it("throws when the shipped pool itself is broken", async () => {
    await expect(choosePool(null, async () => pool(undefined))).rejects.toThrow("baselines.json: no model fingerprint");
    expect(() => parseBaselines("[]", "x")).toThrow("x: version is undefined");
  });

  it("names the pool and its model for Data & settings", () => {
    expect([poolLabel("local", HLTV), poolLabel("shipped", CS2RB)]).toEqual(["Pro pool: local (HLTV model)", "Pro pool: shipped (CS2RB)"]);
  });
});
