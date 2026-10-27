// FFmpeg templates for the clips: finishing one raw take (trim it to the moment, put the moment's
// reason in a lower third, give it a sound track) and joining finished clips into a highlight reel.
// Each returns the argument list; the host runs it (clips.rs clips_ffmpeg), confined to the clips
// folder. ffmpeg.test.ts runs every template on takes made with ffmpeg's testsrc2, so they are
// checked without CS2.
//
// Every finished clip has the same size, frame rate, pixel format and an audio track (silence when
// the take has none), so the reel's concat filter never meets two kinds of stream.

/** Fonts for the lower third, first found wins: Segoe UI Semibold and Bold, then Arial Bold on Windows; DejaVu Sans Bold on Linux. */
export const FONT_CANDIDATES = [
  "C:/Windows/Fonts/seguisb.ttf", "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
];

/** Encoding shared by finished clips and reels: x264 CRF 18 with AAC at 48 kHz stereo, the stream shape the reel's concat needs. */
const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"];

/**
 * A path as a filter option value inside -filter_complex, which FFmpeg unescapes twice
 * (ffmpeg-filters "Notes on filtergraph escaping"): first the graph, where `\ ' [ ] , ;` are special,
 * then the filter's options, where `\ ' :` are. So the path, with forward slashes, is escaped for the
 * options and that result for the graph: C:/a/it's becomes C\\:/a/it\\\'s. ffmpeg.test.ts runs it on a
 * folder with a space, an apostrophe and brackets.
 */
export function filterPath(p: string): string {
  const option = p.replace(/\\/g, "/").replace(/[':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

const num = (x: number) => {
  if (!Number.isFinite(x) || x < 0) throw new Error(`ffmpeg template: ${x} is not a time or size`);
  return String(Math.round(x * 1000) / 1000);
};

/**
 * The lower third's timing in seconds: it fades in IN after the clip starts over FADE, and out so it
 * is gone OUT before the end. Ours; no viewer testing behind them.
 */
export const LOWER_THIRD = { in: 0.4, fade: 0.25, out: 0.4, stagger: 0.08 } as const;

/**
 * drawtext's alpha for text that fades in at `t0` and out before `d`. The expression is single-quoted,
 * which keeps its commas from splitting the graph; FFmpeg 9.0 split it at a backslash-escaped comma
 * (tried 2026-10-26).
 */
function fadeAlpha(t0: number, d: number): string {
  const f = LOWER_THIRD.fade;
  const end = Math.max(t0 + f, d - LOWER_THIRD.out);
  return `'if(lt(t,${num(t0)}),0,if(lt(t,${num(t0 + f)}),(t-${num(t0)})/${num(f)},if(lt(t,${num(end - f)}),1,if(lt(t,${num(end)}),(${num(end)}-t)/${num(f)},0))))'`;
}

export interface FinishSpec {
  /** HLAE's take: video.mp4, and audio.wav beside it when the game's sound was recorded */
  video: string;
  audio: string | null;
  /** UTF-8 text files with the lower third's two lines: the reason, then the match line (map and round) */
  reasonFile: string;
  sublineFile: string;
  fontFile: string;
  /** where in the take the clip starts, and how long it runs, in seconds */
  startS: number;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  out: string;
}

/** One finished clip from a take: trimmed, scaled and padded to the size, the lower third drawn over its bottom left, sound or silence. */
export function finishArgs(s: FinishSpec): string[] {
  if (!(s.durationS > 0)) throw new Error(`ffmpeg template: a clip of ${s.durationS} s`);
  const { width: w, height: h, durationS: d } = s;
  const font = `fontfile=${filterPath(s.fontFile)}`;
  // the lower third: the reason on a dark plate, the match line under it, both fading in a beat apart
  const line = (file: string, size: number, y: string, t0: number, plate: boolean) => [
    // expansion=none: the reason's "+38%" would otherwise start a %{...} expansion and fail the filter
    "drawtext", [font, `textfile=${filterPath(file)}`, "expansion=none", "fontcolor=white", `fontsize=${size}`, `x=${Math.round(w * 0.05)}`, `y=${y}`,
      ...(plate ? ["box=1", "boxcolor=black@0.6", `boxborderw=${Math.round(h * 0.018)}`] : ["shadowcolor=black@0.7", "shadowx=0", `shadowy=${Math.max(1, Math.round(h / 540))}`]),
      `alpha=${fadeAlpha(t0, d)}`].join(":"),
  ].join("=");
  const big = Math.round(h * 0.042), small = Math.round(h * 0.026);
  const yBig = `h-${Math.round(h * 0.17)}`, ySmall = `h-${Math.round(h * 0.17) - big - Math.round(h * 0.03)}`;
  const video = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "setsar=1", `fps=${s.fps}`,
    line(s.reasonFile, big, yBig, LOWER_THIRD.in, true),
    line(s.sublineFile, small, ySmall, LOWER_THIRD.in + LOWER_THIRD.stagger, false),
    "format=yuv420p",
  ].join(",");
  const trim = ["-ss", num(s.startS), "-t", num(d)];
  const audioIn = s.audio ? [...trim, "-i", s.audio] : ["-f", "lavfi", "-t", num(d), "-i", "anullsrc=r=48000:cl=stereo"];
  return [
    "-hide_banner", "-nostdin", "-y", ...trim, "-i", s.video, ...audioIn,
    "-filter_complex", `[0:v]${video}[v];[1:a]aresample=48000,apad[a]`,
    "-map", "[v]", "-map", "[a]", "-t", num(d), ...ENCODE, s.out,
  ];
}

/** Finished clips joined in order into one reel. Needs two clips or more. */
export function reelArgs(clips: string[], out: string): string[] {
  if (clips.length < 2) throw new Error(`ffmpeg template: a reel needs two clips or more, got ${clips.length}`);
  const pads = clips.map((_, i) => `[${i}:v][${i}:a]`).join("");
  return [
    "-hide_banner", "-nostdin", "-y", ...clips.flatMap((c) => ["-i", c]),
    "-filter_complex", `${pads}concat=n=${clips.length}:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]", ...ENCODE, out,
  ];
}

/**
 * A synthetic take, laid out as HLAE writes one: video.mp4 from testsrc2 and, when `tone`, audio.wav
 * from a sine. For the template tests and for trying the pipeline without CS2.
 */
export function testTakeArgs(dir: string, seconds: number, size: [number, number], fps: number, tone: boolean): string[][] {
  const v = ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size[0]}x${size[1]}:rate=${fps}:duration=${num(seconds)}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", `${dir}/video.mp4`];
  const a = ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${num(seconds)}`, `${dir}/audio.wav`];
  return tone ? [v, a] : [v];
}
