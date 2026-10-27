# Clips: how POV clips are rendered

Read by whoever changes the clip renderer (`app/src/clips`, `app/src-tauri/src/clips/`) or runs the first supervised render. It records which render path was chosen and why, what has been checked, and what has not. Issue #11.

## The decision

Clips record through **HLAE** (advancedfx), with a script that runs inside CS2 and drives the demo. The approach comes from CS2-povforge. CS2's own demo tools are the fallback if HLAE breaks after a game update.

I compared three paths on 2026-10-26, reading the two projects' source in reference clones (Chester-chs/CS2-povforge at 91be721, advancedfx/advancedfx at 9200981). Nothing was run against the game.

| | CS2-povforge | HLAE alone | CS2's built-in tools |
|---|---|---|---|
| What it is | A Python app: demoparser2 picks rounds, HLAE records, FFmpeg edits | The recording tool povforge uses: a loader that injects `AfxHookSource2.dll` into cs2.exe, `mirv_streams` recording, a JavaScript scripting API | `playdemo`, `demo_gototick`, `spec_player`, `startmovie` |
| Needs | Windows, Python 3.11, demoparser2, polars, HLAE, FFmpeg | Windows, HLAE, FFmpeg for video output | CS2 only |
| Licence | MIT | MIT | Valve's |
| Writes video | Through HLAE | Yes, an MP4 per take through FFmpeg, with a WAV of the game's sound | TGA frames and a WAV in the game folder; no output folder setting |
| Can find the player and the tick | Yes, through HLAE's script API | Yes: `mirv.getDemoTick()`, entities with `getSteamId()`, the observer target (`misc/mirv-script/src/types/mirv.d.ts`) | Commands only. A cfg cannot read the tick back, so timing is blind |
| Valve matchmaking demos | Named in its README | Plays what CS2 plays | Yes, while the demo matches the game build |
| HLTV demos | Named in its README | Plays what CS2 plays | Same build limit |
| Local demos (`tv_autorecord`) | Untested | Untested | Untested |

Why HLAE with a script:

- It is the only path that can check, inside the game, that the camera is on the right player before it records, and stop exactly at the end tick. A cfg with `mirv_cmd addAtTick` would fire at ticks without knowing where the camera is.
- It writes a finished MP4 per clip. `startmovie` writes raw frames into the game folder.
- povforge is an app, not a library, and its runtime is Python. This app's engine is TypeScript and its host is Rust, so the app copies povforge's approach (its `director.js` and its HLAE command) and credits it (THIRD_PARTY_NOTICES.md). Neither project is bundled.

Every path shares one limit. CS2 refuses a demo recorded on another game build ("Demo file is incompatible with this game version"), and an update can break HLAE until advancedfx ships a fix. advancedfx shipped CS2 fixes in 2.192.3 to 2.192.5 and in 2.192.8 (release notes, read 2026-10-26).

## How a render runs

1. The engine scores moments from facts (`app/src/stats/moments.ts`). A moment has its round, the POV player's SteamID64, and demo ticks with 5 s before the first kill and 3 s after the last (povforge's defaults), kept inside the round: no earlier than freeze end, and no later than the round's end unless a kill came after it. A won clutch runs from when the clutch began to the round's end. The reason's "round impact" adds up the win-probability credit from the player's kills in the round, so it can pass 100% when the round swings back and forth. The ranking points are ours, with no fit behind them.
2. The Clips page says which demo each moment needs. Only a Valve match has one: `<Steam library>\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\<demo>.dem`, named after the match's folder. Plugin recordings, converted logs and pro demos have none, and the page says so per match.
3. Choosing moments and pressing Render sends the host a typed request: each clip's id, its demo's file name, the POV player's SteamID64, its round and the ticks, and the HLAE.exe the user chose. The host (`app/src-tauri/src/clips/job.rs`) checks each demo is a regular file directly in CS2's replays folder, reached without a link, recomputes each clip's id from its demo, player and round and refuses a mismatch, so a request cannot file one moment's clip under another's id, refuses a tick range that runs past the end of the demo (its length comes from the demo's own file info, `CDemoFileInfo.playback_ticks`; the host cannot read the match's round ticks, which are in parquet), and builds the job: HLAE's command from a fixed template, the director script and the plan. The dialog shows the plan, with HLAE's command written for PowerShell (`& 'HLAE.exe' '-noGui' ...`, each argument single-quoted so `&`, `%` and `$` in a path stay literal); it is not a cmd.exe command. The launch itself passes the arguments to the process and uses no shell. Nothing is written until **Save the plan only** or **Launch CS2 with -insecure**, which saves the job in a new folder named to the millisecond with a random suffix. The director and the plan are written to temporary names first and renamed, the plan last, so a plan never exists without its director.
4. Launch (`clips_launch` in `clips/mod.rs`) builds the job again from the request saved in its plan.json, and refuses when the saved plan differs in anything: the command, a demo, a folder or a clip. It writes the director again from that build, so an edited director.js never runs. It takes the clips lock (`clips\clips.lock`, created exclusively), so no other launch or finish can overlap, and refuses while any cs2.exe runs. The command is always HLAE.exe with its hook beside it, this install's cs2.exe, and `-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips` as the game's command line. It draws a fresh 128-bit nonce from the system's random source and writes the launch's record, `jobs\<job>\launches\<nonce>.json` (created exclusively): the take folders each clip already had, and `console.log`'s identity and length. It writes this launch's copy of the director, with the nonce in it, as `launches\<nonce>.js`, and `game\csgo\cfg\cs2stats_clips.cfg`, whose one line loads that copy. If HLAE has no FFmpeg of its own, it writes `ffmpeg\ffmpeg.ini` beside HLAE.exe. Last, it starts HLAE without waiting for it and records HLAE's process id and creation time in `launches\<nonce>.pids.json`. The lock stays until HLAE has exited and no cs2.exe runs; a lock whose processes are gone is stale and is cleared.
5. The director (`app/src/clips/director.template.js`) waits for the menu, sets up `mirv_streams`, and hides the demo bar by setting `demo_ui_mode` to 0 through HLAE's cvar API, keeping the value it found. It then plays each demo in turn. For each clip it seeks 2 s early, puts the camera on the player by SteamID64 in first person, records from the start tick to the end tick, and finally puts `demo_ui_mode` back to the value it found and quits CS2. On an HLAE without the cvar API (before 2.187.4) it leaves `demo_ui_mode` alone, and the bar shows in the clips. Each line it logs starts with `[cs2stats]`, carries the launch's nonce, and lands in `game\csgo\console.log` (`-condebug`).
6. Back in the app, Check again finds the takes. HLAE records each clip into a new numbered folder, `%APPDATA%\BotMatchStats\clips\jobs\<job>\raw\<clip id>\takeNNNN\`, with `video.mp4` in it (or in a named stream's subfolder) and `audio.wav` beside it; the app uses the newest take that is complete (see When a take counts). **Finish** sends the host the clip id, the job, the take folder and the lower third's two lines, with personal info hidden when that setting is on. The host (`app/src-tauri/src/clips/ffmpeg.rs`) resolves the take inside the clips folder, writes the lines to `clips\text\`, takes the font from a fixed list in Windows' Fonts folder, and builds the FFmpeg command, which trims each take to the moment, draws the reason in a lower third and gives it a sound track. No argument may name a protocol or a file-reading filter. FFmpeg writes a new `.part.mp4` file beside the clip, renamed over `<clip id>.mp4` only after it exits cleanly with a non-empty file and removed otherwise, so a failed render never stands as a clip and never replaces a good one; the page lists only non-empty final files. The result is `%APPDATA%\BotMatchStats\clips\<clip id>.mp4`. **Make a reel** joins rendered clips into `clips\reels\`.

## When a take counts

HLAE's script cannot write files (its mirv-script `fs.d.ts` only reads folders), so the director's record is CS2's console log. Three things make that record trustworthy:

- **A nonce per launch.** Every launch gets a fresh 128-bit random nonce, written only into that launch's copy of the director. A demo's chat and player names were recorded before the nonce existed, so they cannot hold it, and a line from an earlier launch holds an older one. The host reads only lines that start with `[cs2stats] END ` and carry this launch's nonce: `[cs2stats] END <clip id> nonce=<nonce> why=<why> tick=<tick>`.
- **Read once, after the processes exit.** A launch is settled when HLAE's own process (its id and creation time) has exited and no cs2.exe runs. Nothing here can confirm that HLAE is the parent the system records for the cs2.exe its loader starts, so "no cs2.exe at all" stands in for "its CS2 has exited". The host then reads `console.log` once and keeps what it found in `launches\<nonce>.result.json`, created exclusively. It reads from the length the log had at launch when it is the same file and has only grown, and from the start otherwise: povforge's notes say each CS2 session replaces the log, and with the nonce a line from another session cannot count anyway. It reads at most 64 MiB.
- **A take belongs to one launch.** A take belongs to the newest launch that started before it existed, which the launch record says (the take folders each clip had). Launches are one at a time under the lock, so that is the launch that made it.

A take is recorded, and Finish accepts it, when its launch is settled, that launch's lines include `END <clip> nonce=<nonce> why=end_tick`, and the take holds a non-empty `video.mp4` and the `audio.wav` the job asked for (the setup always runs `mirv_streams record startMovieWav 1`). No timing check is needed: when a process exits, the system closes its files, and the host reads them through the same system cache. For each clip the page takes the newest take that passes, so a newer take that failed does not hide an older one that worked.

What this cannot detect:

- A launch whose lines never reached the log: CS2 crashed, or was closed before the director logged the clip's `END`. Its takes stay unrecorded; render those moments again.
- A clip the director stopped early (`why=demo_end`, `camera_lost` or `error`) does not count; render it again.
- Whether CS2 writes `mirv.message` lines at the start of a console.log line. The parser requires it, so that chat cannot forge a line; if CS2 prefixes its lines, every take stays unrecorded and the first supervised render will show it.

FFmpeg's part files (`.*.part.mp4`) that a crashed finish leaves are removed at app start and with every scan, while no lock is live.

## What is checked and what is not

Checked without the game:

- Moment scoring has known-answer tests on hand-built rounds (`moments.test.ts`).
- The launch (`clips/launch.rs`) has Rust tests: one launch or finish at a time, and a stale lock cleared; part files swept only while no lock is live; a relaunch after a failed run, where the older take still counts and the old launch's line proves nothing for the new take; chat lines and old or guessed nonces that do not count; a log read from the launch offset only while it is the same grown file; and a launch settled only after its processes exit, and only once.
- A malformed demo is an error, never a panic: truncated, overlong and 64-bit-overflowing varints, lengths past the end and of `u64::MAX`, and every truncation and many single-byte changes of a good file-info frame (`clips/job.rs`).
- The job (`clips/job.rs`) has Rust tests: the exact command, the folder and cfg, grouping by demo, refusals by name, a junction named like a demo, unique ids, and the paired write. The launch's rebuild refuses a tampered plan (an extra game flag, another program, another cfg line) and replaces an edited director (`clips/mod.rs`). Finishing and reels refuse links and paths outside the clips folder.
- The director runs in `director.test.ts` against a stand-in for HLAE's script API, which plays two demos tick by tick and stands in for the cvar API. That checks its order of work, the commands it sends and that `demo_ui_mode` is put back before `quit`, not how CS2 answers them.
- The FFmpeg templates run on synthetic takes from `testsrc2` in a Rust test (`clips/ffmpeg.rs`). It checks durations, stream shapes, where the lower third is drawn and that it is absent before its fade-in, and the reel's length. It skips, saying why, where FFmpeg or a font is missing, as on CI's runners.

Not checked, because nobody has run any of this inside CS2:

- that HLAE 2.192.x starts this game build with these flags, and that `+exec` runs the cfg after HLAE's commands exist;
- that `spec_player <controller index>` with `spec_mode 2` gives the first-person view in a matchmaking demo (povforge's choice, unconfirmed in HLAE's docs);
- that the extractor's ticks (demoparser2) equal what `demo_gototick` and `mirv.getDemoTick()` use. povforge assumes so;
- whether CS2 saves `demo_ui_mode` to the user's config at all, and whether HLAE's cvar API reaches it (the director puts it back either way, but a crash or a closed game before the director's last step would leave it at 0);
- local `tv_autorecord` demos and HLTV demos.

## Threat model

The host's checks (`app/src-tauri/src/clips/`) defend against inputs the app does not control: the web view's requests, a stale or edited `plan.json` or `director.js`, a link or junction left inside the clips folder, and a file disguised as a take. Against those:

- the web view sends typed requests, and the host builds every command and path;
- the launch builds the job again from its saved request and refuses a plan that differs;
- every path read or written is resolved, links included, and checked to be inside its folder; a take, a lower-third file or an output that is itself a link is refused, and so is an output with another hard link, which FFmpeg's overwrite would write through;
- FFmpeg opens each input with a fixed demuxer (`-f mp4`, `-f wav` or `-f lavfi`) and only through the file protocol (`-protocol_whitelist file`), so a playlist or concat list hidden inside a video cannot name other files; the reel uses the concat filter, not the concat demuxer, so `-safe` does not apply;
- files the host writes go to a new temporary name created exclusively and are then renamed into place, so nothing already at that path is written into.

Out of scope: another process running as the same user that can already write to `%APPDATA%\BotMatchStats\clips` or to CS2's replays folder. That process can read anything the user can, so racing a check against it protects nothing. This is the same ruling as the packs folder (#41). For the same reason the `jobs`, `raw` and replays folders themselves may be junctions; the checks resolve them before comparing, and a user can legitimately move CS2's replays folder with one.

## The first supervised render

The user runs this, at the machine, with nothing else using CS2.

1. Download HLAE from https://github.com/advancedfx/advancedfx/releases, unpack it to a folder of your own (`D:\Tools\HLAE`, say), and leave its `x64` folder beside `HLAE.exe`.
2. Install FFmpeg if `ffmpeg -version` fails in a terminal (`winget install Gyan.FFmpeg`).
3. Import a recent Valve match in Data & settings, so its demo is still in CS2's replays folder.
4. Close CS2. Open Clips. The dots for CS2, HLAE and FFmpeg should all be green. If HLAE's is not, its path goes in the Render dialog.
5. Choose one short "Ready to render" moment and press Render. Read the command and the files it lists, then press **Launch CS2 with -insecure**.
6. Leave the game alone. CS2 opens, loads the demo, records and quits. If it does not quit within a few minutes of the clip's length, close it yourself.
7. Back in Clips, press Check again. The moment should read "Recorded". Choose it and press Finish.
8. Check `game\csgo\console.log` for the `[cs2stats]` lines and the finished MP4 for the right player and the right kills. Report the HLAE version, the CS2 build and anything that went wrong on issue #11.
