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
const JOB_ID = "job-20261026T180405123Z-a1b2c3";
const NONCE = "0123456789abcdef0123456789abcdef";
const job = (demos: { path: string; clips: Clip[] }[]) => ({
  id: JOB_ID, nonce: NONCE, outDir: OUT, demos: demos.map((d) => ({ ...d, tickrate: 64 })), setup: SETUP,
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

interface Camera {
  /** the observer mode the demo starts in (3 is chase) */
  mode?: number;
  /** spec_player does nothing before this frame */
  specFromFrame?: number;
  /** an HLAE without getObserverMode */
  noObserverMode?: boolean;
  /** the observer mode each spec_mode value gives; by default the value itself (the schema's numbering) */
  modeFor?: Record<number, number>;
}

/**
 * Plays demos the way the director sees them: playdemo starts a demo at tick 1 a few frames later,
 * each frame advances one tick, demo_gototick jumps, spec_player follows a controller, spec_mode sets
 * the observer mode. Controllers are entities 1..n (the demo's players), their pawns 51..; the local
 * player is 99 with pawn 98. `cvar` is the stand-in AdvancedfxCVar, or undefined for an HLAE without it.
 * `modeAtStart` records the observer mode each time recording starts.
 */
function standIn(demos: Record<string, Demo>, cvar?: unknown, cam: Camera = {}) {
  const execs: string[] = [];
  const logs: string[] = [];
  const modeAtStart: number[] = [];
  let demo: Demo | null = null, loading = 0, tick = -1, observed = 1, quit = false, frame = 0;
  let mode = cam.mode ?? 3;
  let recording = false;
  /** per frame recorded, whether the director sent spec_player for the observed player that frame */
  const heldWhileRecording: boolean[] = [];
  let cb: ((e: { isBefore: boolean; curStage: number }) => void) | null = null;
  const entity = (i: number) => {
    if (i === 99) return { isPlayerController: () => false, getPlayerPawnHandle: () => 98 };
    if (i === 98) {
      const pawn = { isPlayerController: () => false, getObserverTargetHandle: () => observed + 50 };
      return cam.noObserverMode ? pawn : { ...pawn, getObserverMode: () => mode };
    }
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
      if (spec && frame >= (cam.specFromFrame ?? 0)) observed = Number(spec[1]);
      const specMode = /^spec_mode (\d+)$/.exec(c);
      if (specMode) mode = cam.modeFor?.[Number(specMode[1])] ?? Number(specMode[1]);
      if (c === "mirv_streams record start") { modeAtStart.push(mode); recording = true; }
      if (c === "mirv_streams record end") recording = false;
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
    for (; frame < maxFrames && !quit; frame++) {
      if (loading > 0 && --loading === 0) tick = 1;
      else if (demo && tick >= 0) tick++;
      const sent = execs.length, was = recording;
      cb!({ isBefore: false, curStage: 12 });
      if (was && recording) heldWhileRecording.push(execs.slice(sent).includes(`spec_player ${observed}`));
    }
    return { execs, logs, quit, modeAtStart, heldWhileRecording };
  };
}

describe("the director", () => {
  it("records each clip of each demo from its start tick to its end tick on the POV player, then quits", () => {
    // fails if the director records before the camera is on the player, misses a clip's start or end,
    // records into the wrong folder, skips the second demo, or never quits
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100), clip(A2, 3000, 3050)] }, { path: DEMO_B, clips: [clip(B1, 400, 450)] }]);
    const { execs, logs, quit, modeAtStart } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002", ME] }, [DEMO_B]: { ticks: 2000, players: [ME] } })(script(j), 20000);
    expect(quit).toBe(true);
    // every recording starts in first person, though the demo began in chase mode
    expect(modeAtStart).toEqual([2, 2, 2]);
    expect(execs.slice(0, SETUP.length)).toEqual(SETUP);
    const marks = logs.filter((l) => /\] (START|END) /.test(l)).map((l) => l.replace("[cs2stats] ", ""));
    const n = `nonce=${NONCE}`;
    expect(marks).toEqual([
      `START ${A1} tick=1000 ${n}`, `END ${A1} ${n} why=end_tick tick=1100`, `START ${A2} tick=3000 ${n}`, `END ${A2} ${n} why=end_tick tick=3050`,
      `START ${B1} tick=400 ${n}`, `END ${B1} ${n} why=end_tick tick=450`,
    ]);
    // every line carries the launch's nonce
    expect(logs.every((l) => l.includes(n))).toBe(true);
    // seeks land two seconds early
    expect(execs.filter((c) => /^(playdemo|demo_gototick)/.test(c))).toEqual([
      `playdemo "${DEMO_A}"`, "demo_gototick 872", "demo_gototick 2872", `playdemo "${DEMO_B}"`, "demo_gototick 272",
    ]);
    // the camera is held on ME's controller, 2 in the first demo and 1 in the second, and on no one else
    const second = execs.indexOf(`playdemo "${DEMO_B}"`);
    const held = (from: number, to: number) => [...new Set(execs.slice(from, to).filter((c) => c.startsWith("spec_player")))];
    expect([held(0, second), held(second, execs.length)]).toEqual([["spec_player 2"], ["spec_player 1"]]);
    expect(execs.filter((c) => c.startsWith("mirv_streams record name"))).toEqual([A1, A2, B1].map((id) => `mirv_streams record name "${OUT}/${id}"`));
    // the job's block in the console log, which the host copies into its session log (clips/mod.rs capture_sessions)
    expect([logs[0], logs.at(-1)]).toEqual([`[cs2stats] director loaded job=${JOB_ID}: 2 demos nonce=${NONCE}`, `[cs2stats] ALL DONE job=${JOB_ID} nonce=${NONCE}`]);
  });

  it("skips a clip whose player is not in the demo and goes on", () => {
    // fails if a missing player stalls the job, records someone else, or leaves no END line saying why
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100), clip(A2, 3000, 3050)] }]);
    const { logs, quit } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002"] } })(script(j), 20000);
    expect(quit).toBe(true);
    const n = `nonce=${NONCE}`;
    expect(logs.filter((l) => /START|ERROR|END/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `ERROR could not find the player for ${A1}; skipping it ${n}`, `END ${A1} ${n} why=no_player tick=1000`,
      `ERROR could not find the player for ${A2}; skipping it ${n}`, `END ${A2} ${n} why=no_player tick=3000`,
    ]);
  });

  it("records only once the camera is on the player before the start, seeking back when it locked late", () => {
    // fails if a camera that locks after the start tick records a short clip from there and calls it
    // complete (why=end_tick), instead of seeking back so the clip still starts at its start tick
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    // the first seek lands at frame ~311 on tick 872, so the start comes at frame ~439; spec_player works from frame 450
    const { logs, quit, modeAtStart } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002", ME] } }, undefined, { specFromFrame: 450 })(script(j), 20000);
    expect(quit).toBe(true);
    const n = `nonce=${NONCE}`;
    expect(logs.filter((l) => /START|END|seeking back/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `camera not on the player before ${A1} started; seeking back (try 1) ${n}`, `START ${A1} tick=1000 ${n}`, `END ${A1} ${n} why=end_tick tick=1100`,
    ]);
    expect(modeAtStart).toEqual([2]);
  });

  it("skips with camera_late, never end_tick, when the camera never locks before the start", () => {
    // fails if a clip whose camera never reached the player is recorded, or skipped without the END line the host reads
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const { execs, logs, quit } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002", ME] } }, undefined, { specFromFrame: Infinity })(script(j), 20000);
    expect(quit).toBe(true);
    expect(execs).not.toContain("mirv_streams record start");
    const n = `nonce=${NONCE}`;
    expect(logs.filter((l) => /START|END|seeking back/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `camera not on the player before ${A1} started; seeking back (try 1) ${n}`, `camera not on the player before ${A1} started; seeking back (try 2) ${n}`,
      `END ${A1} ${n} why=camera_late tick=1000`,
    ]);
  });

  it("forces first person when the demo already follows the player in chase mode", () => {
    // fails if the camera counts as locked because it follows the right player, while it is in chase mode
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    // ME is controller 1, which the demo camera already follows, in chase mode (3)
    const { execs, modeAtStart } = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } }, undefined, { mode: 3 })(script(j), 20000);
    expect([...new Set(execs.filter((c) => c.startsWith("spec_player")))]).toEqual(["spec_player 1"]);
    expect(execs.indexOf("spec_mode 2")).toBeGreaterThan(-1);
    expect(execs.indexOf("spec_mode 2")).toBeLessThan(execs.indexOf("mirv_streams record start"));
    expect(modeAtStart).toEqual([2]);
  });

  it("holds the camera on the player with spec_player on every recorded frame", () => {
    // fails if the director sends spec_player once and lets CS2 move the camera, which advancedfx #1172
    // found a single spec_player no longer prevents; HLAE's mirv_script_spec_lock sends it every frame
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const { heldWhileRecording } = standIn({ [DEMO_A]: { ticks: 5000, players: ["76561190000000002", ME] } })(script(j), 20000);
    expect(heldWhileRecording.length).toBeGreaterThan(90);
    expect(heldWhileRecording.every(Boolean)).toBe(true);
  });

  it("falls back to spec_mode 1 when spec_mode 2 does not give first person, and records only once the mode reads in-eye", () => {
    // fails if the director asks only for spec_mode 2, or records before the mode reads 2 (in-eye). Here,
    // as advancedfx #1172 reported on CS2 1.41.6.2, spec_mode 1 is the value that gives the in-eye view.
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const { execs, logs, modeAtStart } = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } }, undefined, { mode: 3, modeFor: { 1: 2, 2: 3 } })(script(j), 20000);
    const modes = execs.filter((c) => c.startsWith("spec_mode"));
    expect(modes.slice(0, 31)).toEqual([...Array(30).fill("spec_mode 2"), "spec_mode 1"]);
    expect(modeAtStart).toEqual([2]);
    expect(logs.filter((l) => /START|END/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `START ${A1} tick=1000 nonce=${NONCE}`, `END ${A1} nonce=${NONCE} why=end_tick tick=1100`,
    ]);
  });

  it("skips a clip when HLAE cannot report the observer mode", () => {
    // fails if first person is assumed when it cannot be confirmed
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const { execs, logs, quit } = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } }, undefined, { noObserverMode: true })(script(j), 20000);
    expect(quit).toBe(true);
    expect(execs).not.toContain("mirv_streams record start");
    expect(logs.some((l) => l.startsWith(`[cs2stats] END ${A1} nonce=${NONCE} why=camera_mode_unknown `))).toBe(true);
  });

  it("stops with camera_lost when the camera leaves first person while recording", () => {
    // fails if a recording that switched to chase mode halfway is ended as complete
    const j = job([{ path: DEMO_A, clips: [clip(A1, 1000, 1100)] }]);
    const run = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } });
    const text = script(j).replace("case S.REC:", "case S.REC:\n\t\t\t\tif (tick === 1050) mirv.exec('spec_mode 3');");
    const { logs } = run(text, 20000);
    expect(logs.some((l) => l.startsWith(`[cs2stats] END ${A1} nonce=${NONCE} why=camera_lost tick=105`))).toBe(true);
  });

  it("records a clip that starts just after the earliest start tick the host accepts", () => {
    // the host refuses a start before seekLeadSeconds of demo plus one tick (clips/job.rs MIN_START_S): the
    // director then seeks to tick 1 and still has time to lock the camera before the start
    const start = 2 * 64 + 1;
    const j = job([{ path: DEMO_A, clips: [clip(A1, start, start + 50)] }]);
    const { logs } = standIn({ [DEMO_A]: { ticks: 5000, players: [ME] } })(script(j), 20000);
    expect(logs.filter((l) => /START|END/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `START ${A1} tick=${start} nonce=${NONCE}`, `END ${A1} nonce=${NONCE} why=end_tick tick=${start + 50}`,
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
    expect(bare.logs).toContain(`[cs2stats] WARNING HLAE has no cvar API; the demo bar stays nonce=${NONCE}`);
  });
});
