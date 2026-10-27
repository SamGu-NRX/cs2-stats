// The FFmpeg templates (ffmpeg.ts): their escaping, and every template run by the real ffmpeg on
// synthetic takes from testsrc2, in a folder whose name has a space, an apostrophe and brackets.
// Without ffmpeg on PATH, or without one of FONT_CANDIDATES, the run skips and says which is missing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterPath, finishArgs, FONT_CANDIDATES, reelArgs, testTakeArgs } from "./ffmpeg";

describe("filterPath", () => {
  it("escapes a path for the filter's options and then for the graph", () => {
    // fails if a drive colon, a quote or a bracket reaches FFmpeg unescaped, or a backslash survives
    expect(filterPath("C:/Windows/Fonts/seguisb.ttf")).toBe("C\\\\:/Windows/Fonts/seguisb.ttf");
    expect(filterPath("C:\\clips\\it's [x], y;\\a.txt")).toBe("C\\\\:/clips/it\\\\\\'s \\[x\\]\\, y\\;/a.txt");
  });
});

describe("the templates", () => {
  it("refuses a reel of one clip and a clip of no length", () => {
    expect(() => reelArgs(["a.mp4"], "r.mp4")).toThrow(/two clips or more/);
    expect(() => finishArgs({ video: "v", audio: null, reasonFile: "r", sublineFile: "s", fontFile: "f", startS: 0, durationS: 0, width: 640, height: 360, fps: 30, out: "o" })).toThrow(/a clip of 0 s/);
  });
});

const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
const font = FONT_CANDIDATES.find((f) => existsSync(f)) ?? null;
const missing = !ffmpeg ? "ffmpeg is not on PATH" : !font ? `none of ${FONT_CANDIDATES.join(", ")} exists` : null;
if (missing) console.warn(`clips/ffmpeg.test.ts: skipping the runs on synthetic takes: ${missing}`);

const run = (args: string[]) => {
  const r = spawnSync("ffmpeg", args, { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${r.stderr.toString().slice(-1500)}`);
  return r.stdout;
};
interface Probe { streams: { codec_type: string; width?: number; height?: number; r_frame_rate: string; sample_rate?: string; channels?: number }[]; format: { duration: string } }
const probe = (file: string): Probe => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels:format=duration", "-of", "json", file]).stdout.toString());

const W = 640, H = 360;
/** One frame at `t` seconds, scaled to W x H, as 8-bit gray. */
const gray = (file: string, t: number) => run(["-hide_banner", "-nostdin", "-ss", String(t), "-i", file, "-vf", `scale=${W}:${H},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"]);
/** Mean absolute difference of two gray frames over rows [y0, y1) and columns [0, x1). */
const diff = (a: Buffer, b: Buffer, y0: number, y1: number, x1 = W) => {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) { s += Math.abs(a[y * W + x] - b[y * W + x]); n++; }
  return s / n;
};

describe.skipIf(missing !== null)("the templates on synthetic takes", () => {
  const root = mkdtempSync(join(tmpdir(), "cs2stats-ffmpeg-"));
  const dir = join(root, "it's a [clips] folder");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const take = (name: string, seconds: number, size: [number, number], tone: boolean) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    for (const a of testTakeArgs(d, seconds, size, 30, tone)) run(a);
    return { video: join(d, "video.mp4"), audio: tone ? join(d, "audio.wav") : null };
  };
  const text = (name: string, s: string) => { const f = join(dir, name); writeFileSync(f, s, "utf8"); return f; };

  it("trims a take, draws the lower third after its fade-in, and gives every clip the same streams; the reel joins them", () => {
    // fails if the trim, the size, the frame rate or the sound track is off, the lower third is missing
    // or drawn before its fade-in or outside the bottom of the frame, or the reel loses a clip
    const a = take("take a", 4, [1280, 720], true);
    const b = take("take b", 2, [W, H], false);
    const reason = text("reason.txt", "3K on B Site, opening kill, +38% swing");
    const sub = text("sub.txt", "Mirage · Round 14");
    const fin = (t: typeof a, out: string, startS: number, durationS: number) => {
      run(finishArgs({ ...t, reasonFile: reason, sublineFile: sub, fontFile: font!, startS, durationS, width: W, height: H, fps: 30, out: join(dir, out) }));
      return join(dir, out);
    };
    const fa = fin(a, "a.mp4", 0.5, 3);
    const fb = fin(b, "b.mp4", 0, 2);
    for (const [file, d] of [[fa, 3], [fb, 2]] as const) {
      const p = probe(file);
      expect(Number(p.format.duration)).toBeCloseTo(d, 1);
      expect(p.streams.map((s) => s.codec_type).sort()).toEqual(["audio", "video"]);
      const v = p.streams.find((s) => s.codec_type === "video")!, au = p.streams.find((s) => s.codec_type === "audio")!;
      expect([v.width, v.height, v.r_frame_rate, au.sample_rate, au.channels]).toEqual([W, H, "30/1", "48000", 2]);
    }
    // a's take at 1.5 s is the clip at 1.0 s: the top of the frame matches, the lower third's band does not
    const band = [Math.round(H * 0.8), Math.round(H * 0.9)] as const;
    const clip1 = gray(fa, 1.0), src1 = gray(a.video, 1.5);
    expect(diff(clip1, src1, 0, Math.round(H * 0.5))).toBeLessThan(4);
    expect(diff(clip1, src1, band[0], band[1], W / 2)).toBeGreaterThan(20);
    // before the fade-in (0.1 s) the band is the take's own picture
    expect(diff(gray(fa, 0.1), gray(a.video, 0.6), band[0], band[1], W / 2)).toBeLessThan(4);

    const reel = join(dir, "reel.mp4");
    run(reelArgs([fa, fb], reel));
    const p = probe(reel);
    expect(Number(p.format.duration)).toBeCloseTo(5, 1);
    expect(p.streams.map((s) => s.codec_type).sort()).toEqual(["audio", "video"]);
  }, 120_000);
});
