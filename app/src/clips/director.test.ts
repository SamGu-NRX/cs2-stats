// The director script (director.template.js) run against a stand-in for HLAE's mirv-script API, so
// its order of work and the commands it sends are checked without CS2. The job is a fixture in the
// shape the host writes (src-tauri/src/clips/job.rs director_job, whose own test checks that shape).
import { describe, expect, it } from "vitest";
import template from "./director.template.js?raw";

const ME = "76561190000000001";
const A1 = "c-00000000000000aa-r3", A2 = "c-00000000000000aa-r9", B1 = "c-00000000000000bb-r1";
const DEMO_A = "D:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays/match730_0001.dem";
const DEMO_B = "D:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/replays/match730_0002.dem";
const OUT = "E:/Data/BotMatchStats/clips/jobs/job-20261026T180405123Z-a1b2c3/raw";
const SETUP = ["demo_timescale 1", "mirv_streams record screen enabled 1", "mirv_streams record fps 60"];

interface Clip { id: string; steamid: string; start: number; end: number }
const job = (demos: { path: string; clips: Clip[] }[]) => ({
  outDir: OUT, demos: demos.map((d) => ({ ...d, tickrate: 64 })), setup: SETUP,
  frameStage: 12, bootFrames: 300, loadTimeoutFrames: 20000, seekRetryFrames: 900, finishFrames: 180, seekLeadSeconds: 2, quitWhenDone: true,
});
const clip = (id: string, start: number, end: number): Clip => ({ id, steamid: ME, start, end });
const script = (j: ReturnType<typeof job>) => template.replace("__CS2STATS_JOB__", () => JSON.stringify(j));

interface Demo { ticks: number; players: string[] }

/** A stand-in console variable store, as HLAE's AdvancedfxCVar exposes it (mirv-script cvar.d.ts). */
function cvars(values: Record<string, number>, log: string[]) {
  const names = Object.keys(values);
  return class {
    static getIndexFromName(name: string) { const i = names.indexOf(name); return i < 0 ? undefined : i; }
    constructor(private index: number) {}
    get value() { return values[names[this.index]]; }
    set value(v: number) { values[names[this.index]] = v; log.push(`${names[this.index]}=${v}`); }
  };
}

/**
 * Plays demos the way the director sees them: playdemo starts a demo at tick 1 a few frames later,
 * each frame advances one tick, demo_gototick jumps, spec_player follows a controller. Controllers
 * are entities 1..n (the demo's players), their pawns 51..; the local player is 99 with pawn 98.
 * `cvar` is the stand-in AdvancedfxCVar, or undefined for an HLAE without it.
 */
function standIn(demos: Record<string, Demo>, cvar?: unknown) {
  const execs: string[] = [];
  const logs: string[] = [];
  let demo: Demo | null = null, loading = 0, tick = -1, observed = 1, quit = false;
  let cb: ((e: { isBefore: boolean; curStage: number }) => void) | null = null;
  const entity = (i: number) => {
    if (i === 99) return { isPlayerController: () => false, getPlayerPawnHandle: () => 98 };
    if (i === 98) return { isPlayerController: () => false, getObserverTargetHandle: () => observed + 50 };
    if (demo && i >= 1 && i <= demo.players.length) return { isPlayerController: () => true, getSteamId: () => BigInt(demo!.players[i - 1]) };
    if (demo && i >= 51 && i <= 50 + demo.players.length) return { isPlayerController: () => false, getPlayerControllerHandle: () => i - 50 };
    return null;
  };
  const mirv = {
    message: (m: string) => logs.push(m.trim()),
    exec: (c: string) => {
      execs.push(c);
      const play = /^playdemo "(.+)"$/.exec(c);
      if (play) { demo = demos[play[1]] ?? null; loading = 5; tick = -1; }
      const go = /^demo_gototick (\d+)$/.exec(c);
      if (go) tick = Number(go[1]);
      const spec = /^spec_player (\d+)$/.exec(c);
      if (spec) observed = Number(spec[1]);
      if (c === "quit") quit = true;
    },
    getDemoTick: () => tick,
    isPlayingDemo: () => demo !== null && loading === 0 && tick >= 0 && tick <= demo.ticks,
    isDemoPaused: () => false,
    getHighestEntityIndex: () => 128,
    getEntityFromIndex: entity,
    getEntityFromSplitScreenPlayer: () => entity(99),
    getHandleEntryIndex: (h: number) => h,
    events: { clientFrameStageNotify: { on: (_: string, f: typeof cb) => { cb = f; } } },
  };
  return (text: string, maxFrames: number) => {
    new Function("mirv", "AdvancedfxCVar", text)(mirv, cvar);
    for (let f = 0; f < maxFrames && !quit; f++) {
      if (loading > 0 && --loading === 0) tick = 1;
      else if (demo && tick >= 0) tick++;
      cb!({ isBefore: false, curStage: 12 });
    }
    return { execs, logs, quit };
  };
}

describe("the director", () => {
  it("records each clip of each demo from its start tick to its end tick on the POV player, then quits", () => {
    // fails if the director records before the camera is on the player, misses a clip's start or end,
    // records into the wrong folder, skips the second demo, or never quits
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100), clip(A2, 3000, 3050)] }, { path: DEMO_B, clips: [clip(B1, 400, 450)] }]);
    const { execs, logs, quit } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002", ME] }, [DEMO_B]: { ticks: 2000, players: [ME] } })(script(j), 20000);
    expect(quit).toBe(true);
    expect(execs.slice(0, SETUP.length)).toEqual(SETUP);
    const marks = logs.filter((l) => /\] (START|END) /.test(l)).map((l) => l.replace("[cs2stats] ", ""));
    expect(marks).toEqual([`START ${A1} tick=1000`, `END ${A1} tick=1100 why=end_tick`, `START ${A2} tick=3000`, `END ${A2} tick=3050 why=end_tick`, `START ${B1} tick=400`, `END ${B1} tick=450 why=end_tick`]);
    // seeks land two seconds early; the camera goes to ME's controller: 2 in the first demo, where it
    // stays across the second seek, and 1 in the second
    expect(execs.filter((c) => /^(playdemo|demo_gototick|spec_player)/.test(c))).toEqual([
      `playdemo "${DEMO_A}"`, "demo_gototick 872", "spec_player 2", "demo_gototick 2872",
      `playdemo "${DEMO_B}"`, "demo_gototick 272", "spec_player 1",
    ]);
    expect(execs.filter((c) => c.startsWith("mirv_streams record name"))).toEqual([A1, A2, B1].map((id) => `mirv_streams record name "${OUT}/${id}"`));
  });

  it("skips a clip whose player is not in the demo and goes on", () => {
    // fails if a missing player stalls the job or records someone else
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100), clip(A2, 3000, 3050)] }]);
    const { logs, quit } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002"] } })(script(j), 20000);
    expect(quit).toBe(true);
    expect(logs.filter((l) => /START|ERROR/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `ERROR could not put the camera on the player for ${A1}; skipping it`, `ERROR could not put the camera on the player for ${A2}; skipping it`,
    ]);
  });

  it("hides the demo bar and puts the user's demo_ui_mode back before CS2 quits", () => {
    // fails if the value is left changed, restored after quit (too late to keep it out of the config), or changed without the cvar API
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const changes: string[] = [];
    const values = { demo_ui_mode: 3 };
    const run = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } }, cvars(values, changes));
    const { execs, quit } = run(script(j), 20000);
    expect(quit).toBe(true);
    expect([changes, values.demo_ui_mode]).toEqual([["demo_ui_mode=0", "demo_ui_mode=3"], 3]);
    // the restore happens in the same frame as quit, before it
    expect(execs.at(-1)).toBe("quit");
    // without the API nothing is changed, and the job still runs
    const bare = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } })(script(j), 20000);
    expect(bare.quit).toBe(true);
    expect(bare.logs).toContain("[cs2stats] WARNING HLAE has no cvar API; the demo bar stays");
  });
});
