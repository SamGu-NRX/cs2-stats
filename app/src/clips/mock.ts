// A stand-in clips host for screenshots of states that need CS2, HLAE and a render in flight, which no
// agent may start. `vite dev` and `pnpm capture` load it with ?clips=<scenario> (host.ts clipsHost);
// the import is dynamic and DEV-only, so a release build carries none of it. Every demo the page asks
// about is "on disk", every tool is "found", and nothing it returns came from the machine.
//
// Scenarios:
// - waiting: a launch's CS2 still runs, so the page says "Waiting for CS2 to close" and holds Render;
// - ready: the Render dialog gets its plan at once, with Save and Launch on;
// - held: the plan is never answered, so the dialog shows "Building the plan…" with Save and Launch off,
//   as it does whenever the tools or the HLAE path change under a plan it was showing.
// Save, Launch, Finish and Reel refuse: a screenshot never needs them.
import type { ClipsHost } from "./host";
import type { JobRequest, RenderPlan } from "./plan";

/** Marks this module in a bundle; the release build is checked for its absence (design/clips.md). */
export const MOCK_MARK = "cs2stats-mock-clips-host";

const USER = "C:\\Users\\Player";
const CLIPS = `${USER}\\AppData\\Roaming\\BotMatchStats\\clips`;
const STEAM = "D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive";
const HLAE = `${USER}\\Tools\\HLAE\\HLAE.exe`;
const REFUSE = (what: string) => Promise.reject(new Error(`The stand-in clips host (${MOCK_MARK}) does not ${what}.`));

/** A plan shaped as the Rust host's (src-tauri/src/clips/job.rs Plan) for `request`. */
function planOf(request: JobRequest): RenderPlan {
  const id = "job-20261027T120000000Z-000000";
  const jobDir = `${CLIPS}\\jobs\\${id}`;
  const cs2 = `${STEAM}\\game\\bin\\win64\\cs2.exe`;
  const argv = [request.hlae, "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader", "-hookDllPath", request.hlae.replace(/HLAE\.exe$/, "x64\\AfxHookSource2.dll"),
    "-programPath", cs2, "-cmdLine", "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips"];
  const byDemo = new Map<string, JobRequest["clips"]>();
  for (const c of request.clips) byDemo.set(c.demo, [...(byDemo.get(c.demo) ?? []), c]);
  return {
    version: 2, id, created: "2026-10-27T12:00:00.000Z", settings: { width: 1920, height: 1080, fps: 60 }, jobDir, hlaeExe: argv[0], hookDll: argv[7], cs2Exe: cs2, argv,
    powershell: ["&", ...argv.map((a) => `'${a.replaceAll("'", "''")}'`)].join(" "), cfgFile: "cs2stats_clips.cfg",
    cfgText: `mirv_script_load "${jobDir.replaceAll("\\", "/")}/launches/<launch nonce>.js"\n`, directorFile: `${jobDir}\\director.js`,
    demos: [...byDemo].map(([demo, cs]) => ({
      path: `${STEAM}\\game\\csgo\\replays\\${demo}`, tickRate: cs[0].tickRate,
      clips: [...cs].sort((a, b) => a.startTick - b.startTick).map((c) => ({ id: c.id, steamid: c.steamid, start: c.startTick, end: c.endTick, reason: c.reason })),
    })),
    outputs: [], request, review: "0".repeat(64),
  };
}

/** The stand-in host for `scenario`, or null for a name it does not know. */
export function mockClipsHost(scenario: string): ClipsHost | null {
  if (scenario !== "waiting" && scenario !== "ready" && scenario !== "held") return null;
  return {
    env: async (hlae) => ({
      clipsDir: CLIPS, font: "C:\\Windows\\Fonts\\seguisb.ttf",
      cs2: { path: `${STEAM}\\game\\bin\\win64\\cs2.exe`, error: null }, replays: { path: `${STEAM}\\game\\csgo\\replays`, error: null },
      hlae: { path: hlae ?? HLAE, error: null }, ffmpeg: { path: `${USER}\\scoop\\shims\\ffmpeg.exe`, error: null },
    }),
    demos: async (names) => names.map((name) => ({ name, path: `${STEAM}\\game\\csgo\\replays\\${name}`, size: 1 })),
    scan: async () => ({ finished: [], takes: [], reels: [], waiting: scenario === "waiting" ? 1 : 0 }),
    plan: (request, save) => (save !== null ? REFUSE("save plans")
      : scenario === "held" ? new Promise<RenderPlan>(() => {})
      : Promise.resolve(planOf(request))),
    launch: () => REFUSE("launch CS2"),
    finish: () => REFUSE("run FFmpeg"),
    reel: () => REFUSE("run FFmpeg"),
  };
}
