import { describe, expect, it } from "vitest";
import { toFailure, type LeetifyBridge, type LeetifyFailure, type LeetifyPayload, type LeetifyPlayer, type LeetifyStatus } from "../../../host/leetify";
import { FRESH_MS, LeetifyStore } from "./store";
import { SYNTHETIC_STEAM64, syntheticPayload, syntheticProfile } from "./synthetic";

const NOW = 1_800_000_000_000;
const PLAYER: LeetifyPlayer = { kind: "steam", id: SYNTHETIC_STEAM64 };
const fail = (kind: LeetifyFailure["kind"], retryAfterS: number | null = null): LeetifyFailure => ({ kind, message: `host says ${kind}`, retryAfterS });

/** A bridge whose answers the test sets, recording each call; failures reject as the Tauri host's do. */
function fakeBridge(init: { player?: LeetifyPlayer | null; cached?: LeetifyPayload | null } = {}) {
  const calls: string[] = [];
  const st = { player: init.player === undefined ? PLAYER : init.player, hasKey: false, cached: init.cached ?? null };
  const next: { load?: LeetifyFailure | LeetifyPayload; saveKey?: LeetifyFailure } = {};
  const bridge: LeetifyBridge = {
    status: async (): Promise<LeetifyStatus> => ({ player: st.player, hasKey: st.hasKey, keyStore: true, keyError: null, cooldownS: null }),
    saveKey: async () => { calls.push("saveKey"); if (next.saveKey) throw next.saveKey; st.hasKey = true; },
    clearKey: async () => { calls.push("clearKey"); st.hasKey = false; },
    connect: async () => { calls.push("connect"); st.player = PLAYER; return PLAYER; },
    disconnect: async () => { calls.push("disconnect"); st.player = null; st.cached = null; },
    load: async (refresh) => {
      calls.push(refresh ? "load:refresh" : "load:cache");
      if (!refresh) return st.cached;
      const r = next.load ?? syntheticPayload(NOW);
      if ("kind" in r) throw r;
      st.cached = r;
      return r;
    },
  };
  return { bridge, calls, next, st };
}

describe("the Leetify store", () => {
  it("shows a fresh cached copy without asking Leetify, and refreshes a stale one", async () => {
    // fails if every open of the app sends requests, or an old copy is shown as current
    const fresh = fakeBridge({ cached: syntheticPayload(NOW - FRESH_MS + 1000) });
    const a = new LeetifyStore(fresh.bridge, () => NOW);
    await a.start();
    expect(fresh.calls).toEqual(["load:cache"]);
    expect(a.get().data?.profile.steam64).toBe(SYNTHETIC_STEAM64);
    const stale = fakeBridge({ cached: syntheticPayload(NOW - FRESH_MS) });
    const b = new LeetifyStore(stale.bridge, () => NOW);
    await b.start();
    expect(stale.calls).toEqual(["load:cache", "load:refresh"]);
    expect(b.get().data?.fetchedAt).toBe(NOW);
    expect(b.get().starting).toBe(false);
  });

  it("asks nothing of Leetify when no player is connected", async () => {
    const f = fakeBridge({ player: null });
    const s = new LeetifyStore(f.bridge, () => NOW);
    await s.start();
    expect(f.calls).toEqual([]);
    expect(s.get()).toMatchObject({ starting: false, data: null, error: null });
  });

  it("stops at a key Leetify refuses: no connection, the bad_key error shown", async () => {
    const f = fakeBridge({ player: null });
    const s = new LeetifyStore(f.bridge, () => NOW);
    await s.start();
    f.next.saveKey = fail("bad_key");
    expect(await s.connect(SYNTHETIC_STEAM64, "a-key-leetify-refuses")).toBe(false);
    expect(f.calls).toEqual(["saveKey"]);
    expect(s.get().error?.kind).toBe("bad_key");
    expect(s.get().status?.player).toBeNull();
    // without a key it connects and fetches
    expect(await s.connect(SYNTHETIC_STEAM64, null)).toBe(true);
    expect(s.get()).toMatchObject({ error: null, busy: null });
    expect(s.get().data?.matches.length).toBeGreaterThan(0);
  });

  it("drops the data when Leetify no longer returns the player, and keeps it through a pause or an outage", async () => {
    // fails if the page keeps showing data the host deleted, or loses data over a passing failure
    for (const [kind, kept] of [["rate_limited", true], ["network", true], ["server", true], ["not_found", false], ["private", false]] as const) {
      const f = fakeBridge({ cached: syntheticPayload(NOW) });
      const s = new LeetifyStore(f.bridge, () => NOW);
      await s.start();
      f.next.load = fail(kind, kind === "rate_limited" ? 30 : null);
      expect(await s.refresh(), kind).toBe(false);
      expect(s.get().error?.kind, kind).toBe(kind);
      expect(s.get().data !== null, kind).toBe(kept);
    }
  });

  it("names a reply in an unread shape as bad_response, with the field, and shows no data", async () => {
    const f = fakeBridge();
    f.next.load = { ...syntheticPayload(NOW), profile: syntheticProfile({ rating: { aim: "high" } }) };
    const s = new LeetifyStore(f.bridge, () => NOW);
    await s.start();
    expect(s.get().error).toMatchObject({ kind: "bad_response" });
    expect(s.get().error?.message).toContain("profile.rating.aim");
    expect(s.get().data).toBeNull();
  });

  it("runs one action at a time", async () => {
    const f = fakeBridge({ cached: syntheticPayload(NOW) });
    const s = new LeetifyStore(f.bridge, () => NOW);
    await s.start();
    const [a, b] = await Promise.all([s.refresh(), s.refresh()]);
    expect([a, b]).toEqual([true, false]);
    expect(f.calls.filter((c) => c === "load:refresh")).toHaveLength(1);
  });

  it("disconnects: no player, no data", async () => {
    const f = fakeBridge({ cached: syntheticPayload(NOW) });
    const s = new LeetifyStore(f.bridge, () => NOW);
    await s.start();
    expect(await s.disconnect()).toBe(true);
    expect(s.get().data).toBeNull();
    expect(s.get().status?.player).toBeNull();
  });

  it("reads a host failure as it was sent, and anything else as a storage failure with its text", () => {
    expect(toFailure({ kind: "rate_limited", message: "pause", retryAfterS: 12 })).toEqual({ kind: "rate_limited", message: "pause", retryAfterS: 12 });
    expect(toFailure(new Error("disk full"))).toEqual({ kind: "storage", message: "disk full", retryAfterS: null });
    expect(toFailure({ kind: "nonsense" }).kind).toBe("storage");
  });
});
