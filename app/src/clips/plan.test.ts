// Render plan generation (plan.ts), and the director it writes run against a stand-in for HLAE's
// mirv-script API, so the job's commands and the director's order of work are checked without CS2.
import { describe, expect, it } from "vitest";
import { buildRenderJob, CFG_NAME, directorScript, gameArgs, hlaeArgv, jobFiles, quoteArg, RENDER_DEFAULTS, type RenderClip, type RenderEnv } from "./plan";

const env: RenderEnv = { clipsDir: String.raw`E:\Data\BotMatchStats\clips`, hlaeExe: String.raw`D:\Tools\HLAE\HLAE.exe`, cs2Exe: String.raw`D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe` };
const DEMO_A = String.raw`D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_0001.dem`;
const DEMO_B = String.raw`D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_0002.dem`;
const ME = "76561190000000001";
const clip = (id: string, demoPath: string, startTick: number, endTick: number): RenderClip => ({ id, demoPath, steamid: ME, startTick, endTick, tickRate: 64, reason: `reason ${id}` });
const NOW = new Date("2026-10-26T18:04:05.123Z");
const A1 = "c-00000000000000aa-r3", A2 = "c-00000000000000aa-r9", B1 = "c-00000000000000bb-r1";

describe("buildRenderJob", () => {
  it("writes the exact HLAE command, with -insecure inside the game's arguments", () => {
    // fails if a flag HLAE's custom loader needs goes missing or moves, the hook DLL is not beside HLAE.exe, or -insecure leaves the game's command line
    const job = buildRenderJob([clip(A1, DEMO_A, 1000, 2000)], env, RENDER_DEFAULTS, NOW);
    expect(job.argv).toEqual([
      String.raw`D:\Tools\HLAE\HLAE.exe`, "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
      "-hookDllPath", String.raw`D:\Tools\HLAE\x64\AfxHookSource2.dll`,
      "-programPath", env.cs2Exe,
      "-cmdLine", "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips",
    ]);
    expect(job.commandLine).toBe(String.raw`D:\Tools\HLAE\HLAE.exe -noGui -autoStart -noConfig -afxDisableSteamStorage -customLoader -hookDllPath D:\Tools\HLAE\x64\AfxHookSource2.dll -programPath "D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe" -cmdLine "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips"`);
    expect(gameArgs(RENDER_DEFAULTS)[0]).toBe("-insecure");
    expect(hlaeArgv(env.hlaeExe, env.cs2Exe, RENDER_DEFAULTS)).toEqual(job.argv);
  });

  it("names the job by time, keeps its files outside the game, and points the cfg at the director", () => {
    // fails if the job folder leaves the clips folder, the cfg loads another file, or outputs lose their take or finished path
    const job = buildRenderJob([clip(A1, DEMO_A, 1000, 2280)], env, RENDER_DEFAULTS, NOW);
    expect([job.id, job.jobDir]).toEqual(["job-20261026T180405Z", String.raw`E:\Data\BotMatchStats\clips\jobs\job-20261026T180405Z`]);
    expect(job.cfg).toEqual({ file: `${CFG_NAME}.cfg`, text: 'mirv_script_load "E:/Data/BotMatchStats/clips/jobs/job-20261026T180405Z/director.js"\n' });
    expect(job.outputs).toEqual([{
      id: A1, take: `E:\\Data\\BotMatchStats\\clips\\jobs\\job-20261026T180405Z\\raw\\${A1}`, finished: `E:\\Data\\BotMatchStats\\clips\\${A1}.mp4`, reason: `reason ${A1}`, durationS: 20,
    }]);
    expect(jobFiles(job).map((f) => f.name)).toEqual(["plan.json", "director.js"]);
    expect(JSON.parse(jobFiles(job)[0].text)).toEqual(job);
  });

  it("groups clips by demo in the order chosen, each demo's clips in tick order", () => {
    // fails if two demos' clips mix, or a demo's clips are out of order, which would make the director seek backwards
    const job = buildRenderJob([clip(A2, DEMO_A, 9000, 9500), clip(B1, DEMO_B, 100, 900), clip(A1, DEMO_A, 1000, 2000)], env, RENDER_DEFAULTS, NOW);
    expect(job.demos.map((d) => [d.path, d.clips.map((c) => c.id)])).toEqual([[DEMO_A, [A1, A2]], [DEMO_B, [B1]]]);
  });

  it("refuses what the director cannot record, naming the clip", () => {
    // fails if a bad clip or setting reaches a job instead of a specific error
    const ok = clip(A1, DEMO_A, 1000, 2000);
    const bad: [Partial<RenderClip>, RegExp][] = [
      [{ id: "../x" }, /not a clip id/],
      [{ startTick: 2000, endTick: 2000 }, /not a range/],
      [{ steamid: "BOT Kev" }, /no SteamID64/],
      [{ demoPath: String.raw`D:\x\match.json.gz` }, /not a \.dem file/],
    ];
    for (const [patch, msg] of bad) expect(() => buildRenderJob([{ ...ok, ...patch }], env, RENDER_DEFAULTS, NOW)).toThrow(msg);
    expect(() => buildRenderJob([], env, RENDER_DEFAULTS, NOW)).toThrow(/no clips/);
    expect(() => buildRenderJob([ok, ok], env, RENDER_DEFAULTS, NOW)).toThrow(/chosen twice/);
    expect(() => buildRenderJob([ok], env, { ...RENDER_DEFAULTS, fps: 1000 }, NOW)).toThrow(/fps/);
    expect(() => buildRenderJob([ok], { ...env, hlaeExe: String.raw`D:\Tools\evil.exe` }, RENDER_DEFAULTS, NOW)).toThrow(/not HLAE\.exe/);
    expect(() => buildRenderJob([ok, { ...clip(A2, DEMO_A, 3000, 4000), tickRate: 128 }], env, RENDER_DEFAULTS, NOW)).toThrow(/disagree on the tick rate/);
  });
});

it("quotes arguments as CommandLineToArgvW reads them", () => {
  // fails if a space, a quote or trailing backslashes before the closing quote come out wrong
  expect([quoteArg("plain"), quoteArg("a b"), quoteArg('say "hi"'), quoteArg("C:\\a b\\"), quoteArg("")]).toEqual(["plain", '"a b"', '"say \\"hi\\""', '"C:\\a b\\\\"', '""']);
});

// ---------------------------------------------------------------- the director, against a stand-in mirv

interface Demo { ticks: number; players: string[] }

/**
 * Plays demos the way the director sees them: playdemo starts a demo at tick 1 a few frames later,
 * each frame advances one tick, demo_gototick jumps, spec_player follows a controller. Controllers
 * are entities 1..n (the demo's players), their pawns 51..; the local player is 99 with pawn 98.
 */
function standIn(demos: Record<string, Demo>) {
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
  const run = (script: string, maxFrames: number) => {
    new Function("mirv", script)(mirv);
    for (let f = 0; f < maxFrames && !quit; f++) {
      if (loading > 0 && --loading === 0) tick = 1;
      else if (demo && tick >= 0) tick++;
      cb!({ isBefore: false, curStage: 12 });
    }
    return { execs, logs, quit };
  };
  return run;
}

describe("the director", () => {
  it("records each clip of each demo from its start tick to its end tick on the POV player, then quits", () => {
    // fails if the director records before the camera is on the player, misses a clip's start or end,
    // records into the wrong folder, skips the second demo, or never quits
    const job = buildRenderJob([clip(A1, DEMO_A, 1000, 1100), clip(A2, DEMO_A, 3000, 3050), clip(B1, DEMO_B, 400, 450)], env, RENDER_DEFAULTS, NOW);
    const other = "76561190000000002";
    const demos = { [DEMO_A.replace(/\\/g, "/")]: { ticks: 5000, players: [other, ME] }, [DEMO_B.replace(/\\/g, "/")]: { ticks: 2000, players: [ME] } };
    const { execs, logs, quit } = standIn(demos)(directorScript(job), 20000);
    expect(quit).toBe(true);
    // the setup runs once, before the first demo
    expect(execs.slice(0, 7)).toEqual(["demo_timescale 1", "demo_ui_mode 0", "mirv_streams record screen enabled 1",
      'mirv_streams settings add ffmpeg cs2stats "-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16 {QUOTE}{AFX_STREAM_PATH}\\\\video.mp4{QUOTE}"',
      "mirv_streams record screen settings cs2stats", "mirv_streams record fps 60", "mirv_streams record startMovieWav 1"]);
    const marks = logs.filter((l) => /\] (START|END) /.test(l)).map((l) => l.replace("[cs2stats] ", ""));
    expect(marks).toEqual([`START ${A1} tick=1000`, `END ${A1} tick=1100 why=end_tick`, `START ${A2} tick=3000`, `END ${A2} tick=3050 why=end_tick`, `START ${B1} tick=400`, `END ${B1} tick=450 why=end_tick`]);
    // seeks land two seconds early; the camera goes to ME's controller: 2 in the first demo, where it
    // stays across the second seek, and 1 in the second
    expect(execs.filter((c) => /^(playdemo|demo_gototick|spec_player)/.test(c))).toEqual([
      `playdemo "${DEMO_A.replace(/\\/g, "/")}"`, "demo_gototick 872", "spec_player 2", "demo_gototick 2872",
      `playdemo "${DEMO_B.replace(/\\/g, "/")}"`, "demo_gototick 272", "spec_player 1",
    ]);
    expect(execs.filter((c) => c.startsWith("mirv_streams record name"))).toEqual([A1, A2, B1].map((id) => `mirv_streams record name "E:/Data/BotMatchStats/clips/jobs/job-20261026T180405Z/raw/${id}"`));
  });

  it("skips a clip whose player is not in the demo and goes on", () => {
    // fails if a missing player stalls the job or records someone else
    const job = buildRenderJob([clip(A1, DEMO_A, 1000, 1100), clip(A2, DEMO_A, 3000, 3050)], env, RENDER_DEFAULTS, NOW);
    const { logs, quit } = standIn({ [DEMO_A.replace(/\\/g, "/")]: { ticks: 5000, players: ["76561190000000002"] } })(directorScript(job), 20000);
    expect(quit).toBe(true);
    expect(logs.filter((l) => /START|ERROR/.test(l)).map((l) => l.replace("[cs2stats] ", ""))).toEqual([
      `ERROR could not put the camera on the player for ${A1}; skipping it`, `ERROR could not put the camera on the player for ${A2}; skipping it`,
    ]);
  });
});
