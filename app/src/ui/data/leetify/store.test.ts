import { describe, expect, it } from "vitest";
import { toFailure, type LeetifyBridge, type LeetifyFailure, type LeetifyPayload, type LeetifyPlayer, type LeetifyStatus } from "../../../host/leetify";
import { parsePayload } from "./api";
import { LeetifyStore, leetifyPhase, type LeetifyState } from "./store";
import { SYNTHETIC_STEAM64, syntheticPayload, syntheticProfile } from "./synthetic";

const NOW = 1_800_000_000_000;
const PLAYER: LeetifyPlayer = { kind: "steam", id: SYNTHETIC_STEAM64 };
const fail = (kind: LeetifyFailure["kind"], retryAfterS: number | null = null): LeetifyFailure => ({ kind, message: `host says ${kind}`, retryAfterS });

/** A bridge whose answers the test sets, recording each call; failures reject as the Tauri host's do. */
function fakeBridge(init: { player?: LeetifyPlayer | null; held?: LeetifyPayload | null } = {}) {
  const calls: string[] = [];
  const st = { player: init.player === undefined ? PLAYER : init.player, hasKey: false, held: init.held ?? null };
  const next: { load?: LeetifyFailure | LeetifyPayload; saveKey?: LeetifyFailure } = {};
  const bridge: LeetifyBridge = {
    status: async (): Promise<LeetifyStatus> => ({ player: st.player, hasKey: st.hasKey, keyStore: true, keyError: null, cooldownS: null }),
    saveKey: async () => { calls.push("saveKey"); if (next.saveKey) throw next.saveKey; st.hasKey = true; },
    clearKey: async () => { calls.push("clearKey"); st.hasKey = false; },
    connect: async () => { calls.push("connect"); st.player = PLAYER; return PLAYER; },
    disconnect: async () => { calls.push("disconnect"); st.player = null; st.held = null; },
    discard: async () => { calls.push("discard"); st.held = null; },
    badge: async () => null,
    load: async (refresh) => {
      calls.push(refresh ? "load:refresh" : "load:memory");
      if (!refresh) return st.held;
      const r = next.load ?? syntheticPayload(NOW);
      if ("kind" in r) throw r;
      st.held = r;
      return r;
    },
  };
  return { bridge, calls, next, st };
}

describe("the Leetify store", () => {
  it("fetches when the app starts, and takes the host's session copy after a page reload", async () => {
    // fails if a start shows nothing until Refresh, or a reload within the session sends requests again
    const start = fakeBridge();
    const a = new LeetifyStore(start.bridge);
    await a.start();
    expect(start.calls).toEqual(["load:memory", "load:refresh"]);
    expect(a.get().data?.fetchedAt).toBe(NOW);
    expect(a.get().starting).toBe(false);
    const reload = fakeBridge({ held: syntheticPayload(NOW - 3_600_000) });
    const b = new LeetifyStore(reload.bridge);
    await b.start();
    expect(reload.calls).toEqual(["load:memory"]);
    expect(b.get().data?.profile.steam64).toBe(SYNTHETIC_STEAM64);
  });

  it("asks nothing of Leetify when no player is connected", async () => {
    const f = fakeBridge({ player: null });
    const s = new LeetifyStore(f.bridge);
    await s.start();
    expect(f.calls).toEqual([]);
    expect(s.get()).toMatchObject({ starting: false, data: null, error: null });
  });

  it("stops at a key Leetify refuses: no connection, the bad_key error shown", async () => {
    const f = fakeBridge({ player: null });
    const s = new LeetifyStore(f.bridge);
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
      const f = fakeBridge({ held: syntheticPayload(NOW) });
      const s = new LeetifyStore(f.bridge);
      await s.start();
      f.next.load = fail(kind, kind === "rate_limited" ? 30 : null);
      expect(await s.refresh(), kind).toBe(false);
      expect(s.get().error?.kind, kind).toBe(kind);
      expect(s.get().data !== null, kind).toBe(kept);
    }
  });

  it("names a fresh reply in an unread shape as bad_response, shows none of it, and fetches anew on Try again", async () => {
    // fails if part of an unreadable reply renders, or a retry gets the same unreadable copy back
    const f = fakeBridge({ held: syntheticPayload(NOW) });
    const s = new LeetifyStore(f.bridge);
    await s.start();
    expect(s.get().data).not.toBeNull();
    f.next.load = { ...syntheticPayload(NOW), profile: syntheticProfile({ rating: { aim: "high" } }) };
    expect(await s.refresh()).toBe(false);
    expect(s.get().error).toMatchObject({ kind: "bad_response" });
    expect(s.get().error?.message).toContain("profile.rating.aim");
    expect(s.get().data, "the earlier good copy is not shown beside an unreadable one either").toBeNull();
    expect(f.calls.slice(-2)).toEqual(["load:refresh", "discard"]);
    delete f.next.load;
    expect(await s.refresh()).toBe(true);
    expect(s.get()).toMatchObject({ error: null });
    expect(s.get().data?.profile.rating.aim).toBe(62.4);
  });

  it("drops a session copy it cannot read and fetches at once", async () => {
    // fails if an unreadable copy from the host keeps the views on an error with no retry (review of #52)
    const f = fakeBridge({ held: { ...syntheticPayload(NOW), matches: [{ id: 1 }] } });
    const s = new LeetifyStore(f.bridge);
    await s.start();
    expect(f.calls).toEqual(["load:memory", "discard", "load:refresh"]);
    expect(s.get()).toMatchObject({ error: null, starting: false });
    expect(s.get().data?.matches.length).toBeGreaterThan(0);
  });

  it("runs one action at a time", async () => {
    const f = fakeBridge({ held: syntheticPayload(NOW) });
    const s = new LeetifyStore(f.bridge);
    await s.start();
    const [a, b] = await Promise.all([s.refresh(), s.refresh()]);
    expect([a, b]).toEqual([true, false]);
    expect(f.calls.filter((c) => c === "load:refresh")).toHaveLength(1);
  });

  it("drops the data when Disconnect fails at the key store, and shows that failure", async () => {
    // fails if the page keeps a profile the host already dropped (review of #52)
    const f = fakeBridge({ held: syntheticPayload(NOW) });
    f.bridge.disconnect = async () => { f.calls.push("disconnect"); f.st.player = null; f.st.held = null; throw fail("key_store"); };
    const s = new LeetifyStore(f.bridge);
    await s.start();
    expect(await s.disconnect()).toBe(false);
    expect(s.get().data).toBeNull();
    expect(s.get().error?.kind).toBe("key_store");
    expect(leetifyPhase(s.get())).toBe("off");
  });

  it("disconnects: no player, no data", async () => {
    const f = fakeBridge({ held: syntheticPayload(NOW) });
    const s = new LeetifyStore(f.bridge);
    await s.start();
    expect(await s.disconnect()).toBe(true);
    expect(s.get().data).toBeNull();
    expect(s.get().status?.player).toBeNull();
  });

  it("lets a view show Leetify's numbers only once they are in", () => {
    // fails if a view can show numbers while loading or after a failure, or a "not connected" state for a connected player
    const st = (over: Partial<LeetifyState>): LeetifyState => ({ starting: false, status: null, data: null, busy: null, error: null, ...over });
    const status = (player: typeof PLAYER | null) => ({ player, hasKey: false, keyStore: true, keyError: null, cooldownS: null });
    expect(leetifyPhase(null)).toBe("none");
    expect(leetifyPhase(st({ starting: true }))).toBe("none");
    expect(leetifyPhase(st({ status: status(null) }))).toBe("off");
    expect(leetifyPhase(st({ starting: true, status: status(PLAYER) }))).toBe("loading");
    expect(leetifyPhase(st({ status: status(PLAYER), busy: "refresh" }))).toBe("loading");
    expect(leetifyPhase(st({ status: status(PLAYER), error: fail("network") }))).toBe("failed");
    expect(leetifyPhase(st({ error: fail("storage") }))).toBe("failed");
    expect(leetifyPhase(st({ status: status(PLAYER), data: parsePayload(syntheticPayload(NOW)), error: fail("network") }))).toBe("ready");
  });

  it("reads a host failure as it was sent, and anything else as a storage failure with its text", () => {
    expect(toFailure({ kind: "rate_limited", message: "pause", retryAfterS: 12 })).toEqual({ kind: "rate_limited", message: "pause", retryAfterS: 12 });
    expect(toFailure(new Error("disk full"))).toEqual({ kind: "storage", message: "disk full", retryAfterS: null });
    expect(toFailure({ kind: "nonsense" }).kind).toBe("storage");
  });
});
