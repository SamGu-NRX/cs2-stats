# Clips: how POV clips are rendered

Read by whoever changes the clip renderer (`app/src/clips`, `app/src-tauri/src/clips.rs`) or runs the first supervised render. It records which render path was chosen and why, what has been checked, and what has not. Issue #11.

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

1. The engine scores moments from facts (`app/src/stats/moments.ts`). A moment has its round, the POV player's SteamID64, and demo ticks with 5 s before the first kill and 3 s after the last (povforge's defaults). A won clutch runs from when the clutch began to the round's end. The ranking points are ours, with no fit behind them.
2. The Clips page says which demo each moment needs. Only a Valve match has one: `<Steam library>\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\<demo>.dem`, named after the match's folder. Plugin recordings, converted logs and pro demos have none, and the page says so per match.
3. Choosing moments and pressing Render builds the job in memory (`app/src/clips/plan.ts`) and shows it: the HLAE command, the files it writes and the clips. Nothing is written until **Save the plan only** or **Launch CS2 with -insecure**.
4. Launch (`clips_launch` in `clips.rs`) refuses while any cs2.exe runs. It also refuses a command that differs from the one plan.ts writes: HLAE.exe with its hook beside it, this install's cs2.exe, and a game command line that starts with `-insecure`, has no token that turns VAC on, and runs only `+exec cs2stats_clips`. It then writes `game\csgo\cfg\cs2stats_clips.cfg`, whose one line loads the director script from the job folder. If HLAE has no FFmpeg of its own, it writes `ffmpeg\ffmpeg.ini` beside HLAE.exe. Last, it starts HLAE and does not wait for it.
5. The director (`app/src/clips/director.template.js`) waits for the menu, sets up `mirv_streams`, then plays each demo in turn. For each clip it seeks 2 s early, puts the camera on the player by SteamID64 in first person, records from the start tick to the end tick, and then quits CS2. Each line it logs starts with `[cs2stats]` and lands in `game\csgo\console.log` (`-condebug`).
6. Back in the app, Check again finds the takes in `%APPDATA%\BotMatchStats\clips\jobs\<job>\raw\<clip id>\`. **Finish** runs the FFmpeg template (`app/src/clips/ffmpeg.ts`), which trims each take to the moment, draws the reason in a lower third and gives it a sound track. The result is `%APPDATA%\BotMatchStats\clips\<clip id>.mp4`. **Make a reel** joins rendered clips into `clips\reels\`.

## What is checked and what is not

Checked without the game:

- Moment scoring has known-answer tests on hand-built rounds (`moments.test.ts`).
- Plan generation and the HLAE command are tested flag by flag (`plan.test.ts`). The director runs in the test against a stand-in for HLAE's script API, which plays two demos tick by tick. That checks its order of work and the commands it sends, not how CS2 answers them.
- The launch's command check, the FFmpeg argument confinement and the job files have Rust tests (`clips.rs`).
- The FFmpeg templates run on synthetic takes from `testsrc2` (`ffmpeg.test.ts`). The test checks durations, stream shapes, where the lower third is drawn and that it is absent before its fade-in, and the reel's length.

Not checked, because nobody has run any of this inside CS2:

- that HLAE 2.192.x starts this game build with these flags, and that `+exec` runs the cfg after HLAE's commands exist;
- that `spec_player <controller index>` with `spec_mode 2` gives the first-person view in a matchmaking demo (povforge's choice, unconfirmed in HLAE's docs);
- that the extractor's ticks (demoparser2) equal what `demo_gototick` and `mirv.getDemoTick()` use. povforge assumes so;
- whether `demo_ui_mode 0` is saved to the user's CS2 config;
- local `tv_autorecord` demos and HLTV demos.

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
