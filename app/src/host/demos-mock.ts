// A stand-in demos host for screenshots of the Demos card in states that need recorded matches, which
// no agent may play. `vite dev` loads it with ?demos=<scenario> (demos.ts demosHost); the import is
// dynamic and DEV-only, so a release build carries none of it. Nothing it returns came from the
// machine. Pin, delete and the limits change its own copy, so the card can be driven by hand.
//
// Scenarios:
// - kept: a store well under its cap, with demos kept for each reason;
// - held: over the cap with only pinned and unextracted demos left, so a sweep deletes nothing more;
// - failed: an extraction that failed, and a demo deleted by hand outside the app;
// - empty: recording on, nothing recorded yet.
import type { DemoPolicy, DemoRow, DemoStore, DemosHost, Keep } from "./demos";

/** Marks this module in a bundle: a release build must not contain it (search dist for it after pnpm build). */
export const MOCK_MARK = "cs2stats-mock-demos-host";

const GB = 2 ** 30, MB = 2 ** 20;
const FOLDER = String.raw`C:\Users\Player\AppData\Roaming\BotMatchStats\demos`;

/**
 * What the app fills in from its own match list (data/demos.ts demoViews), for rows the stand-in has
 * no tables for: the match's result and its best moment. A screenshot shows them as the real card
 * would; the match link opens a bundled converted log.
 */
export interface SampleFill { file: string; result: "W" | "L" | "T"; us: number; them: number; bestMoment: string | null; bestMomentScore: number | null; plugin: "rounds" | "time" | null }
const SAMPLE_MATCH = "samples/20261024T233426Z_de_dust2_dfa2ac5b.json.gz";

const row = (id: string, size: number, over: Partial<DemoRow> = {}): DemoRow => ({
  id, map: id.split("_").slice(1, -1).join("_"), createdUtc: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:00Z`,
  size, state: "extracted", pinned: false, gameBuild: "2000935", failReason: null, failDetail: null, kept: "recent", ...over,
});

function scenario(name: string): { demos: DemoRow[]; policy: DemoPolicy; free: number; fills: Record<string, SampleFill> } | null {
  const policy = { capGb: 20, floorGb: 10, keepLast: 10 };
  switch (name) {
    case "kept": return {
      policy, free: 48.3 * GB,
      demos: [
        row("20261106T2112Z_de_mirage_4c1e9a07", 118 * MB, { state: "taken", kept: "not extracted yet" }),
        row("20261106T1940Z_de_dust2_a83f0b52", 131 * MB),
        row("20261105T2205Z_de_inferno_19d7c3e4", 96 * MB, { kept: "moment" }),
        row("20261104T2031Z_de_ancient_e2b6501f", 142 * MB),
        row("20261102T1818Z_de_nuke_7f20aa93", 104 * MB, { kept: "moment" }),
        row("20261028T2250Z_de_dust2_0b9e44d1", 127 * MB, { pinned: true, kept: "pinned", gameBuild: "2000912" }),
      ],
      fills: {
        "20261106T1940Z_de_dust2_a83f0b52": { file: SAMPLE_MATCH, result: "W", us: 13, them: 9, bestMoment: "Opening kill on Long A", bestMomentScore: 1, plugin: "rounds" },
        "20261105T2205Z_de_inferno_19d7c3e4": { file: SAMPLE_MATCH, result: "L", us: 10, them: 13, bestMoment: "4K on Banana, +46% round impact", bestMomentScore: 9.6, plugin: "rounds" },
        "20261104T2031Z_de_ancient_e2b6501f": { file: SAMPLE_MATCH, result: "W", us: 13, them: 4, bestMoment: null, bestMomentScore: null, plugin: "time" },
        "20261102T1818Z_de_nuke_7f20aa93": { file: SAMPLE_MATCH, result: "W", us: 13, them: 11, bestMoment: "Clutch won 1v3 on Outside", bestMomentScore: 5, plugin: "rounds" },
        "20261028T2250Z_de_dust2_0b9e44d1": { file: SAMPLE_MATCH, result: "W", us: 13, them: 7, bestMoment: "Ace on B Site", bestMomentScore: 8, plugin: null },
      },
    };
    case "held": return {
      policy, free: 11.2 * GB,
      demos: [
        row("20261106T2112Z_de_mirage_4c1e9a07", 6.4 * GB, { state: "taken", kept: "not extracted yet" }),
        row("20261106T1940Z_de_dust2_a83f0b52", 7.1 * GB, { state: "taken", kept: "not extracted yet" }),
        row("20261028T2250Z_de_dust2_0b9e44d1", 7.9 * GB, { pinned: true, kept: "pinned" }),
      ],
      fills: { "20261028T2250Z_de_dust2_0b9e44d1": { file: SAMPLE_MATCH, result: "W", us: 13, them: 7, bestMoment: "Ace on B Site", bestMomentScore: 8, plugin: null } },
    };
    case "failed": return {
      policy, free: 31.6 * GB,
      demos: [
        row("20261106T2112Z_de_mirage_4c1e9a07", 2 * MB, { state: "failed", failReason: "no_rounds", failDetail: "RuntimeError: no round_end events after match start", kept: "extraction failed; retried when the extractor changes" }),
        row("20261105T2205Z_de_inferno_19d7c3e4", 96 * MB, { kept: "moment" }),
        row("20261103T2010Z_de_overpass_5a0c7e18", 113 * MB, { state: "missing", kept: null }),
      ],
      fills: { "20261105T2205Z_de_inferno_19d7c3e4": { file: SAMPLE_MATCH, result: "L", us: 10, them: 13, bestMoment: "4K on Banana, +46% round impact", bestMomentScore: 9.6, plugin: "rounds" } },
    };
    case "empty": return { policy, free: 48.3 * GB, demos: [], fills: {} };
  }
  return null;
}

/** The stand-in for `name`, or null for a scenario it does not know. */
export function mockDemosHost(name: string): (DemosHost & { sample: Record<string, SampleFill> }) | null {
  const s = scenario(name);
  if (!s) return null;
  let { demos, policy } = s;
  const status = async (): Promise<DemoStore> => {
    const live = demos.filter((d) => d.state !== "missing");
    const used = live.reduce((a, d) => a + d.size, 0);
    const cap = policy.capGb * GB, floor = policy.floorGb * GB;
    const over = used > cap, under = s.free < floor;
    const onlyProtected = live.every((d) => d.pinned || d.state === "taken" || d.state === "failed");
    const failed = demos.find((d) => d.state === "failed");
    return {
      folder: FOLDER, used, cap, floor, free: s.free, freeError: null, keepLast: policy.keepLast, recording: true, demos,
      lastFailure: failed ? { id: failed.id, reason: failed.failReason, detail: failed.failDetail } : null,
      held: (over || under) && onlyProtected ? { overCap: over, underFloor: under } : null,
    };
  };
  return {
    sample: s.fills,
    status,
    async setPolicy(p, seen) {
      if (seen.capGb !== policy.capGb || seen.floorGb !== policy.floorGb || seen.keepLast !== policy.keepLast) throw new Error(`the demo settings changed since they were read; nothing was written (${MOCK_MARK})`);
      policy = p;
      return status();
    },
    async pin(id, on) {
      demos = demos.map((d) => (d.id === id ? { ...d, pinned: on, kept: on ? "pinned" : "recent" } : d));
      return status();
    },
    async remove(id) {
      demos = demos.filter((d) => d.id !== id);
      return status();
    },
    sweep: async (_keeps: Keep[]) => status(),
  };
}
