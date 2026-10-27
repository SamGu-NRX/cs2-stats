//! FFmpeg templates for the clips, built here from paths this module resolved itself: finishing one
//! raw take (trim it to the moment, the moment's reason in a lower third, a sound track) and joining
//! finished clips into a reel. The web view sends clip ids and the lower third's text, never an
//! argument. Every input and output is checked inside the clips folder with links resolved, the text
//! reaches drawtext only through a file this module writes there, the font comes from a fixed list,
//! and `check_built` refuses any argument that names a protocol or a file-reading filter.
//!
//! Every finished clip has the same size, frame rate, pixel format and an audio track (silence when
//! the take has none), so the reel's concat filter never meets two kinds of stream. The tests run the
//! templates on takes made with FFmpeg's testsrc2.

use std::path::{Path, PathBuf};

/// Encoding shared by finished clips and reels: x264 CRF 18 with AAC at 48 kHz stereo, the stream shape the reel's concat needs.
const ENCODE: [&str; 18] = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
];

/// The lower third's timing in seconds: it fades in IN after the clip starts over FADE, and out so it
/// is gone OUT before the end; the second line follows STAGGER later. Ours; no viewer testing behind them.
const IN: f64 = 0.4;
const FADE: f64 = 0.25;
const OUT: f64 = 0.4;
const STAGGER: f64 = 0.08;

/// One input, opened only as `format` and only through the file protocol: FFmpeg would otherwise
/// pick the demuxer from the file's content, and a playlist or concat list disguised as a take could
/// name other files. `lavfi` reads no file at all. The reel joins clips with the concat filter, not the
/// concat demuxer, so `-safe` has nothing to apply to.
fn input(format: &str, path: String) -> [String; 6] {
    ["-protocol_whitelist".into(), "file".into(), "-f".into(), format.into(), "-i".into(), path]
}

/// The demuxers an input may be forced to: HLAE's takes (mp4 video, wav sound), the finished clips
/// (mp4) and the generated silence (lavfi).
const INPUT_FORMATS: [&str; 3] = ["mp4", "wav", "lavfi"];

/// The fonts the lower third may use, first found wins: Segoe UI Semibold and Bold, then Arial Bold,
/// in Windows' Fonts folder; DejaVu Sans Bold on Linux, for the tests.
fn font_candidates() -> Vec<(PathBuf, &'static str)> {
    let mut v = Vec::new();
    if let Some(win) = std::env::var_os("WINDIR").or_else(|| std::env::var_os("SystemRoot")) {
        let fonts = PathBuf::from(win).join("Fonts");
        for n in ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"] {
            v.push((fonts.clone(), n));
        }
    }
    v.push((PathBuf::from("/usr/share/fonts/truetype/dejavu"), "DejaVuSans-Bold.ttf"));
    v.push((PathBuf::from("/usr/share/fonts/dejavu"), "DejaVuSans-Bold.ttf"));
    v
}

/// The lower third's font: the first of the fixed candidates that is a regular file inside its fonts
/// folder once links are resolved. None when no candidate is installed.
pub fn allowed_font() -> Option<PathBuf> {
    font_candidates().into_iter().find_map(|(dir, name)| super::file_inside(&dir, &dir.join(name)).ok())
}

/// A path as a filter option value inside -filter_complex, which FFmpeg unescapes twice
/// (ffmpeg-filters "Notes on filtergraph escaping"): first the graph, where `\ ' [ ] , ;` are special,
/// then the filter's options, where `\ ' :` are. So the path, with forward slashes, is escaped for the
/// options and that result for the graph: C:/a/it's becomes C\\:/a/it\\\'s.
pub fn filter_path(p: &Path) -> String {
    let fwd = p.display().to_string().replace('\\', "/");
    let option: String = fwd.chars().flat_map(|c| if matches!(c, '\'' | ':') { vec!['\\', c] } else { vec![c] }).collect();
    option.chars().flat_map(|c| if matches!(c, '\\' | '\'' | '[' | ']' | ',' | ';') { vec!['\\', c] } else { vec![c] }).collect()
}

fn num(x: f64) -> String {
    let r = (x * 1000.0).round() / 1000.0;
    format!("{r}")
}

/// drawtext's alpha for text that fades in at `t0` and out before `d`. The expression is single-quoted,
/// which keeps its commas from splitting the graph; FFmpeg 9.0 split it at a backslash-escaped comma
/// (tried 2026-10-26).
fn fade_alpha(t0: f64, d: f64) -> String {
    let end = (t0 + FADE).max(d - OUT);
    format!(
        "'if(lt(t,{a}),0,if(lt(t,{b}),(t-{a})/{f},if(lt(t,{c}),1,if(lt(t,{e}),({e}-t)/{f},0))))'",
        a = num(t0), b = num(t0 + FADE), f = num(FADE), c = num(end - FADE), e = num(end)
    )
}

pub struct FinishSpec<'a> {
    /// HLAE's take: video.mp4, and audio.wav beside it when the game's sound was recorded
    pub video: &'a Path,
    pub audio: Option<&'a Path>,
    /// UTF-8 text files with the lower third's two lines, written by this module
    pub reason_file: &'a Path,
    pub subline_file: &'a Path,
    pub font: &'a Path,
    /// where in the take the clip starts, and how long it runs, in seconds
    pub start_s: f64,
    pub duration_s: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub out: &'a Path,
}

/// One finished clip from a take: trimmed, scaled and padded to the size, the lower third drawn over its bottom left, sound or silence.
pub fn finish_args(s: &FinishSpec) -> Result<Vec<String>, String> {
    if !(s.duration_s.is_finite() && s.duration_s > 0.0 && s.start_s.is_finite() && s.start_s >= 0.0) {
        return Err(format!("FFmpeg template: a clip of {} s from {} s", s.duration_s, s.start_s));
    }
    let (w, h, d) = (s.width as f64, s.height as f64, s.duration_s);
    let font = format!("fontfile={}", filter_path(s.font));
    // the lower third: the reason on a dark plate, the match line under it, both fading in a beat apart
    let line = |file: &Path, size: f64, y: String, t0: f64, plate: bool| {
        let mut o = vec![
            font.clone(),
            format!("textfile={}", filter_path(file)),
            // expansion=none: the reason's "+38%" would otherwise start a %{...} expansion and fail the filter
            "expansion=none".into(),
            "fontcolor=white".into(),
            format!("fontsize={}", size.round()),
            format!("x={}", (w * 0.05).round()),
            format!("y={y}"),
        ];
        if plate {
            o.extend(["box=1".into(), "boxcolor=black@0.6".into(), format!("boxborderw={}", (h * 0.018).round())]);
        } else {
            o.extend(["shadowcolor=black@0.7".into(), "shadowx=0".into(), format!("shadowy={}", (h / 540.0).round().max(1.0))]);
        }
        o.push(format!("alpha={}", fade_alpha(t0, d)));
        format!("drawtext={}", o.join(":"))
    };
    let (big, small) = ((h * 0.042).round(), (h * 0.026).round());
    let band = (h * 0.17).round();
    let video = [
        format!("scale={}:{}:force_original_aspect_ratio=decrease", s.width, s.height),
        format!("pad={}:{}:(ow-iw)/2:(oh-ih)/2", s.width, s.height),
        "setsar=1".into(),
        format!("fps={}", s.fps),
        line(s.reason_file, big, format!("h-{band}"), IN, true),
        line(s.subline_file, small, format!("h-{}", band - big - (h * 0.03).round()), IN + STAGGER, false),
        "format=yuv420p".into(),
    ]
    .join(",");
    let trim = ["-ss".to_string(), num(s.start_s), "-t".into(), num(d)];
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y"].map(String::from).to_vec();
    a.extend(trim.iter().cloned());
    a.extend(input("mp4", s.video.display().to_string()));
    match s.audio {
        Some(au) => {
            a.extend(trim.iter().cloned());
            a.extend(input("wav", au.display().to_string()));
        }
        None => {
            a.extend(["-t".into(), num(d)]);
            a.extend(input("lavfi", "anullsrc=r=48000:cl=stereo".into()));
        }
    }
    a.extend(["-filter_complex".into(), format!("[0:v]{video}[v];[1:a]aresample=48000,apad[a]")]);
    a.extend(["-map", "[v]", "-map", "[a]", "-t"].map(String::from));
    a.push(num(d));
    a.extend(ENCODE.map(String::from));
    a.push(s.out.display().to_string());
    Ok(a)
}

/// Finished clips joined in order into one reel. Needs two clips or more.
pub fn reel_args(clips: &[PathBuf], out: &Path) -> Result<Vec<String>, String> {
    if clips.len() < 2 {
        return Err(format!("FFmpeg template: a reel needs two clips or more, got {}", clips.len()));
    }
    let pads: String = (0..clips.len()).map(|i| format!("[{i}:v][{i}:a]")).collect();
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y"].map(String::from).to_vec();
    for c in clips {
        a.extend(input("mp4", c.display().to_string()));
    }
    a.extend(["-filter_complex".into(), format!("{pads}concat=n={}:v=1:a=1[v][a]", clips.len())]);
    a.extend(["-map", "[v]", "-map", "[a]"].map(String::from));
    a.extend(ENCODE.map(String::from));
    a.push(out.display().to_string());
    Ok(a)
}

/// A last check on arguments this module built: none may name a protocol (`file:`, `http:`, any
/// `scheme:` of two letters or more, which a drive letter is not) or a filter that reads a file of its
/// own (`movie=`, `amovie=`). The templates never write them; a path that happened to would be refused.
///
/// Every input must also be opened as `-protocol_whitelist file -f <one of INPUT_FORMATS> -i`.
pub fn check_built(args: &[String]) -> Result<(), String> {
    for (i, a) in args.iter().enumerate() {
        if a == "-i" {
            let before = &args[i.saturating_sub(4)..i];
            if i < 4 || before[..3] != ["-protocol_whitelist", "file", "-f"] || !INPUT_FORMATS.contains(&before[3].as_str()) {
                return Err(format!("FFmpeg input {} is not opened as -protocol_whitelist file -f <format>", args.get(i + 1).map_or("", String::as_str)));
            }
        }
    }
    for a in args {
        let low = a.to_ascii_lowercase();
        if low.contains("movie=") || low.contains("file:") {
            return Err(format!("FFmpeg argument {a} names a file-reading filter or a file: URL"));
        }
        let scheme: String = low.chars().take_while(|c| c.is_ascii_alphanumeric() || "+.-".contains(*c)).collect();
        if scheme.len() >= 2 && low[scheme.len()..].starts_with(':') && low.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return Err(format!("FFmpeg argument {a} names a protocol"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    fn a_path_is_escaped_for_the_options_and_then_for_the_graph() {
        assert_eq!(filter_path(Path::new("C:/Windows/Fonts/seguisb.ttf")), r"C\\:/Windows/Fonts/seguisb.ttf");
        assert_eq!(filter_path(Path::new(r"C:\clips\it's [x], y;\a.txt")), r"C\\:/clips/it\\\'s \[x\]\, y\;/a.txt");
    }

    #[test]
    fn built_arguments_may_name_no_protocol_or_file_reading_filter() {
        let mut ok: Vec<String> = input("mp4", r"C:\clips\a.mp4".into()).to_vec();
        ok.extend(input("lavfi", "anullsrc=r=48000:cl=stereo".into()));
        ok.extend(["[0:v]fps=60[v]", "/tmp/a.mp4"].map(String::from));
        check_built(&ok).unwrap();
        // an input left to content detection, or opened with another demuxer or protocol list
        for bad in [vec!["-i", "a.mp4"], vec!["-protocol_whitelist", "file", "-f", "hls", "-i", "a.mp4"], vec!["-protocol_whitelist", "file,http", "-f", "mp4", "-i", "a.mp4"]] {
            assert!(check_built(&bad.iter().map(|x| x.to_string()).collect::<Vec<_>>()).is_err(), "{bad:?}");
        }
        for bad in ["file:///C:/secret.txt", "FILE:C:/x", "http://example.com/x.mp4", "concat:a.mp4|b.mp4", "[0:v]movie=C\\:/secret.mp4[m]", "amovie=x.wav"] {
            assert!(check_built(&[bad.to_string()]).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_input_is_opened_with_a_forced_demuxer_through_the_file_protocol_only() {
        let p = Path::new("x.mp4");
        let w = Path::new("x.wav");
        let s = FinishSpec { video: p, audio: Some(w), reason_file: p, subline_file: p, font: p, start_s: 1.0, duration_s: 3.0, width: 640, height: 360, fps: 30, out: p };
        let inputs = |args: &[String]| -> Vec<Vec<String>> {
            args.iter().enumerate().filter(|(_, a)| a.as_str() == "-i").map(|(i, _)| args[i - 4..=i + 1].to_vec()).collect()
        };
        let want = |f: &str, path: &str| ["-protocol_whitelist", "file", "-f", f, "-i", path].map(String::from).to_vec();
        let finish = finish_args(&s).unwrap();
        assert_eq!(inputs(&finish), [want("mp4", "x.mp4"), want("wav", "x.wav")]);
        check_built(&finish).unwrap();
        let silent = finish_args(&FinishSpec { audio: None, ..s }).unwrap();
        assert_eq!(inputs(&silent), [want("mp4", "x.mp4"), want("lavfi", "anullsrc=r=48000:cl=stereo")]);
        let reel = reel_args(&[PathBuf::from("a.mp4"), PathBuf::from("b.mp4")], Path::new("r.mp4")).unwrap();
        assert_eq!(inputs(&reel), [want("mp4", "a.mp4"), want("mp4", "b.mp4")]);
    }

    #[test]
    fn the_templates_refuse_a_reel_of_one_and_a_clip_of_no_length() {
        assert!(reel_args(&[PathBuf::from("a.mp4")], Path::new("r.mp4")).unwrap_err().contains("two clips or more"));
        let p = Path::new("x");
        let s = FinishSpec { video: p, audio: None, reason_file: p, subline_file: p, font: p, start_s: 0.0, duration_s: 0.0, width: 640, height: 360, fps: 30, out: p };
        assert!(finish_args(&s).unwrap_err().contains("a clip of 0 s"));
    }

    // ---------------------------------------------------------------- on synthetic takes

    fn tool(name: &str) -> Option<PathBuf> {
        let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(&exe)).find(|p| p.is_file())
    }
    fn run(ffmpeg: &Path, args: &[String]) -> Vec<u8> {
        let o = Command::new(ffmpeg).args(args).output().unwrap();
        assert!(o.status.success(), "ffmpeg {}\n{}", args.join(" "), String::from_utf8_lossy(&o.stderr));
        o.stdout
    }
    const W: usize = 640;
    const H: usize = 360;
    /// One frame at `t` seconds, scaled to W x H, as 8-bit gray.
    fn gray(ffmpeg: &Path, file: &Path, t: f64) -> Vec<u8> {
        let args: Vec<String> = ["-hide_banner", "-nostdin", "-ss", &t.to_string(), "-i", &file.display().to_string(), "-vf", &format!("scale={W}:{H},format=gray"), "-frames:v", "1", "-f", "rawvideo", "-"].map(String::from).to_vec();
        run(ffmpeg, &args)
    }
    /// Mean absolute difference of two gray frames over rows [y0, y1) and columns [0, x1).
    fn diff(a: &[u8], b: &[u8], y0: usize, y1: usize, x1: usize) -> f64 {
        let mut s = 0u64;
        for y in y0..y1 {
            for x in 0..x1 {
                s += (a[y * W + x] as i64 - b[y * W + x] as i64).unsigned_abs();
            }
        }
        s as f64 / ((y1 - y0) * x1) as f64
    }
    #[derive(serde::Deserialize)]
    struct Probe {
        streams: Vec<serde_json::Value>,
        format: serde_json::Value,
    }
    fn probe(ffprobe: &Path, f: &Path) -> Probe {
        let o = Command::new(ffprobe).args(["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels:format=duration", "-of", "json"]).arg(f).output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap()
    }

    #[test]
    fn the_templates_trim_draw_the_lower_third_after_its_fade_in_and_join_a_reel() {
        let (Some(ffmpeg), Some(ffprobe), Some(font)) = (tool("ffmpeg"), tool("ffprobe"), allowed_font()) else {
            eprintln!("clips::ffmpeg: skipping the runs on synthetic takes: ffmpeg, ffprobe or a lower-third font is missing");
            return;
        };
        // a folder whose name has a space, an apostrophe and brackets, which the filter escaping must survive
        let root = std::env::temp_dir().join(format!("cs2stats-ffmpeg-{}", std::process::id()));
        let dir = root.join("it's a [clips] folder");
        let _ = fs::remove_dir_all(&root);
        let take = |name: &str, secs: u32, size: &str, tone: bool| {
            let d = dir.join(name);
            fs::create_dir_all(&d).unwrap();
            let v = d.join("video.mp4");
            run(&ffmpeg, &["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", &format!("testsrc2=size={size}:rate=30:duration={secs}"), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", &v.display().to_string()].map(String::from));
            let a = d.join("audio.wav");
            if tone {
                run(&ffmpeg, &["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", &format!("sine=frequency=440:sample_rate=48000:duration={secs}"), &a.display().to_string()].map(String::from));
            }
            (v, tone.then_some(a))
        };
        let (va, aa) = take("take a", 4, "1280x720", true);
        let (vb, ab) = take("take b", 2, "640x360", false);
        let reason = dir.join("reason.txt");
        fs::write(&reason, "3K on B Site, opening kill, +38% round impact").unwrap();
        let sub = dir.join("sub.txt");
        fs::write(&sub, "Mirage · Round 14").unwrap();
        let fin = |v: &Path, a: Option<&Path>, out: &str, start_s: f64, duration_s: f64| {
            let out = dir.join(out);
            let args = finish_args(&FinishSpec { video: v, audio: a, reason_file: &reason, subline_file: &sub, font: &font, start_s, duration_s, width: W as u32, height: H as u32, fps: 30, out: &out }).unwrap();
            check_built(&args).unwrap();
            run(&ffmpeg, &args);
            out
        };
        let fa = fin(&va, aa.as_deref(), "a.mp4", 0.5, 3.0);
        let fb = fin(&vb, ab.as_deref(), "b.mp4", 0.0, 2.0);
        for (f, d) in [(&fa, 3.0), (&fb, 2.0)] {
            let p = probe(&ffprobe, f);
            let dur: f64 = p.format["duration"].as_str().unwrap().parse().unwrap();
            assert!((dur - d).abs() < 0.05, "{} lasts {dur} s, not {d}", f.display());
            let kinds: Vec<&str> = p.streams.iter().map(|s| s["codec_type"].as_str().unwrap()).collect();
            assert!(kinds.contains(&"video") && kinds.contains(&"audio"), "{kinds:?}");
            let v = p.streams.iter().find(|s| s["codec_type"] == "video").unwrap();
            let au = p.streams.iter().find(|s| s["codec_type"] == "audio").unwrap();
            assert_eq!((v["width"].as_u64(), v["height"].as_u64(), v["r_frame_rate"].as_str()), (Some(W as u64), Some(H as u64), Some("30/1")));
            assert_eq!((au["sample_rate"].as_str(), au["channels"].as_u64()), (Some("48000"), Some(2)));
        }
        // a's take at 1.5 s is the clip at 1.0 s: the top of the frame matches, the lower third's band does not
        let (b0, b1) = ((H as f64 * 0.8) as usize, (H as f64 * 0.9) as usize);
        let (clip1, src1) = (gray(&ffmpeg, &fa, 1.0), gray(&ffmpeg, &va, 1.5));
        assert!(diff(&clip1, &src1, 0, H / 2, W) < 4.0);
        assert!(diff(&clip1, &src1, b0, b1, W / 2) > 20.0, "no lower third in the band");
        // before the fade-in (0.1 s) the band is the take's own picture
        assert!(diff(&gray(&ffmpeg, &fa, 0.1), &gray(&ffmpeg, &va, 0.6), b0, b1, W / 2) < 4.0);
        let reel = dir.join("reel.mp4");
        let args = reel_args(&[fa, fb], &reel).unwrap();
        check_built(&args).unwrap();
        run(&ffmpeg, &args);
        let dur: f64 = probe(&ffprobe, &reel).format["duration"].as_str().unwrap().parse().unwrap();
        assert!((dur - 5.0).abs() < 0.1, "the reel lasts {dur} s");
        let _ = fs::remove_dir_all(&root);
    }
}
