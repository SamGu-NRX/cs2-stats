# Recording: local demos from Bot Mode matches

Read by whoever changes how the app records, keeps or reads the demos CS2 writes during a Bot Mode match (`extractor/local_import.py`, the host's `demos` module, the `local` source), or runs the first supervised recorded match. It records the decision, the numbers behind it, and what is still unproven.

## The decision

- CS2 records each Bot Mode match itself, with GOTV. Bot Mode's launch options switch it on when the "Record demos" setting is on, which it is by default.
- The demo is a cache and the extracted tables are the product. The app extracts a demo when CS2 exits.
- A demo stays only while one of these holds: it has clip-worthy moments not yet rendered, the user pinned it, or it is among the last 10. Everything kept stays under a 20 GB cap, and recording stops while the disk has less than 10 GB free.
- Demos are not compressed and not cut.
- The plugin stays. It is the line-of-sight oracle and the fallback recorder.

Rejected:
- **The plugin starting `tv_record`.** `tv_enable` must be set before the map loads either way, and it would cost a plugin release.
- **Client POV `record`.** It can crash the client, and it holds only what the recording player's client was sent.
- **Cutting the demo to the clip windows.** The only CS2 trimmer found (jhohen217/demoparser) is unproven, and CS2 needs a full packet at the cut's start.

## What is known

- **A listen server records at full rate.** A `tv_autorecord` demo from a Bot Mode session, written by CS2 1.41.9.2, sits in `game\csgo\replays\`, not `game\csgo\`. demoparser2 reads it as `valve_demo_2`: 2975 distinct ticks with every gap 1, so 64 snapshots a second and no tick missing.
- **What that demo holds:** warmup, the warmup's `round_end`, `begin_new_match` on the next tick, one `round_freeze_end`, and then nothing. The extractor refuses it with `no round_end events after match start`, and `local_import.py` reports that as `no_rounds`. So recording works; a complete recorded match is not yet proven.
- **The file name carries the Steam name.** `tv_autorecord` names the file `auto-<date>-<time>-<map>-<server name>.dem`, and a listen server is named after the player hosting it. The demo is renamed (see Storage), and the header's server name is not stored (`match.server_name` is empty for source `local`).
- **What that rule covers, and what it does not.** The server name from the file name must never reach anything derived from the file name: team names, `dem_file`, the import result (`failed_checks`, `final_score`, errors) or a log. `extract_demo` enforces it for source `local`: it refuses to run without an id, and scrubs the original name from everything it returns. Player names are another matter. The tables hold them for a recorded demo exactly as they do for a Valve or plugin match: they stay on the user's PC, and the app's "hide personal info" setting governs whether they are shown.
- **Expected size** (a hypothesis until a full match is recorded): about 70 to 150 MB a match, up to 300 MB at the HLTV rate.
  - The cut-off demo runs 587 bytes a tick, mostly warmup and freeze time.
  - Valve matchmaking demos (`match730_*.dem`) run 870 to 2040 bytes a tick (31 to 150 MB).
  - Pro HLTV demos run about 2.4 KB a tick.
  - A 24-round bot match is about 120k ticks.
- **Compression does not pay.** zstd on a 358 MB pro demo gives 1.40 at `-1`, 1.52 at `-3`, 1.60 at `-9` and 1.61 at `-9 --long=27`, because the packets are already Snappy-compressed.

## Recording

When `record_demos` is on, `launch::steam_args` appends `+tv_enable 1 +tv_autorecord 1 +tv_maxclients 0` after the user's own launch options. `-insecure` stays first and the secure-token check is unchanged. The launch dialog shows the tokens.

Steam adds CS2's stored launch options after the app's, so a `tv_enable`, `tv_autorecord` or `tv_maxclients` there wins over the tokens. Any mention of one counts, whatever its value or form: `+` or `-`, any case, quoted or not, or no value at all. Their values are not read, so recording is never half on. The app never edits Steam's options. Such a launch goes ahead without the tokens, with `-insecure` still third, and the dialog says why, for example "Recording off this time: your Steam launch options set tv_enable." The options are read again just before Steam is asked to start CS2; if they have come to mention one, the launch stops and asks to be started again.

Each of these is a hypothesis, checked in the supervised session below:
- `+tv_enable 1` on the command line is early enough for the first match. If not, it moves to `cfg/autoexec.cfg` through the existing merged-cfg write.
- `tv_maxclients 0` does not stop recording.
- The GOTV slot does not disturb the bot match. The plugin file's player count shows it.
- `tv_delay` does not cut off the end of the match. If it does, add `+tv_delay 0`.
- `tv_snapshotrate` stays at its default, which already records every tick.

**Linking a demo to its plugin file.** Both are of the same map, and the gaps between consecutive `round_freeze_end` ticks agree: the plugin's `rounds.freezeTick` deltas equal the tables' `rounds.freeze_end_tick` deltas over the rounds both hold, skipping partial plugin rounds. Ticks themselves differ between the two, so only the deltas are compared. The fallback, when too few rounds overlap: same map, the demo's creation time (its sidecar's `created_utc`) is before the plugin's `startUtc`, and no other demo of that map lies between them.

Other cases:
- **Warmup:** the extractor already drops it.
- **Map change:** CS2 closes the demo.
- **`mp_restartgame`:** one demo holds two games. A later change splits the demo at each `begin_new_match` that follows a real round end. Until then the ledger records `restart_in_demo`, and the plugin file serves the match.
- **Crash:** the extractor's truncated-demo path (SCHEMA-v1.md, "Truncated demos") handles it.

## Fidelity

The tick rate stays at 64 and the cvar is not exposed. At 32 or 16 snapshots a second:
- event ticks round to 2 or 4 ticks;
- shot-state staleness grows to 15.6 or 47 ms;
- the visibility onset error grows to ±1 or ±2 ticks, which breaks the acceptance row in architecture.md at 16 and makes it marginal at 32.

Revisit this only if a full match comes in above 300 MB.

## Storage

All under `%APPDATA%\BotMatchStats\`:

```
demos\<id>.dem               moved out of replays\ once CS2 has exited (same-volume rename, under OpLock)
demos\<id>.meta.json         sha256, dem_bytes, map, created_utc, game_build, state
demos\ledger.jsonl           taken, extracted, failed(reason), kept(reason), pinned, deleted, missing
local\<id>\v-<ver>-<nonce>\  schema v1 tables, with CURRENT and COMPLETE as in valve\
```

`<id>` is `<yyyymmddThhmmZ>_<map>_<sha8>`: the file's creation time in UTC, the header's map, and the first 8 hex digits of its SHA-256. The creation time survives the same-volume move. The original name is never stored or shown.

**Retention.** The host enforces it, and the app's engine decides what to keep, because only the engine scores moments (`scoreMoments` in `app/src/stats/moments.ts`).
- Cap: 20 GB of demos. Floor: 10 GB free. Below the floor nothing is recorded. The launch goes ahead without the `+tv_*` tokens, and the dialog says why.
- Pre-launch reserve: 1 GB, so the match being recorded does not take the disk under the floor. It is checked once, before the launch; see Failure modes for what it cannot prevent.
- Kept, in this order: pinned (never evicted); a demo with an unrendered moment scoring at least a 3k; among the last 10.
- Eviction takes demos from an older game build first, because CS2 refuses to play them, so they cannot make clips. The build comes from `steam.inf`'s ClientVersion at import. After that, oldest first.
- A demo whose extraction failed is kept until the extractor version changes once.
- The sweep runs before every Bot Mode launch and at session end, both with CS2 closed.

**Extraction.** An import takes finished demos out of `replays\`, runs `local_import.py` on the ones not yet extracted, and sweeps. It runs in two places. The Bot Mode supervisor runs one after a session ends with CS2 exited, once it has released the session lease, so it works with the app closed. The app runs one at start, for anything a session left behind. A file lock in the Bot Mode folder lets one run at a time across both processes. The importer runs the way `import_valve` runs it, with `CS2_MAPDATA` when it is set. When the importer is not installed, the take and the sweep still run, so demos never pile up in `replays\` or past the cap. Until the app sends its keeps, a sweep keeps pinned, unextracted and the newest demos, under the cap and above the floor.

**The take.** Each `auto-*.dem` is opened once, shared with no one, and everything happens through that handle: the checks, the hash, the move and the removal. While CS2 writes the demo, or anything else holds it open, the open fails and the demo waits for the next take; while the app holds it, nothing else can write, rename or delete it. A demo is taken once its last write is 60 s old. CS2 is checked again right before each move or removal. On one volume the handle is renamed into the store. Across volumes (a Steam library on another drive), it is copied into a temporary file in the store, flushed, checked against its hash and renamed into place. The original is then deleted through its handle, only if CS2 is still closed. If CS2 has started, the original stays and the copy stands; a later take with CS2 closed finds the copy by its hash and deletes the original.

**Threat model.** The store protects against two things: links that lead elsewhere by accident, and the game being active. An accidental link is a junction or symlink at or inside `demos\`, or a hard link to a file in it, any of which would make a write or a delete land on a file outside the store. This is a single-user local app. An active local attacker racing the app to swap files between its checks is out of scope: anyone with that access can delete the files directly.

**Store access.** The folders above `demos\` may be junctions, because some users move AppData with one. `demos\` itself is refused when it is a junction or link, and its canonical path is read once for each operation. Every file operation in the store goes through one module, `app/src-tauri/src/demos/handle.rs`: sidecars, demos, the ledger, the keeps file and temporary files. A file is opened by a single-component name without following a link at that name, and its handle is checked: a regular file, not a reparse point, with exactly one link, whose final path is directly inside `demos\`. It is then read, written, renamed or deleted through that same handle. A file that fails a check is not touched, and the ledger records why (`refused`). No store file is changed by its path.

**The ledger.** Each record is written whole with its newline and flushed to disk. A record cut off by a crash is dropped before the next one is written, and the drop is itself a record (`ledger_repaired`).

## Reading the demos

- A new source, `local`, labelled "Recorded demo", supports what the pro source supports.
- The host lists and reads `local\` with `list_local` and `read_local`, the Valve folder's rules generalized to a root and a prefix.
- **Whose match it is.** `match.extra.pov` holds the only human in the demo when there is exactly one. Otherwise it holds the user's SteamID64 (`valve-user.local.json`, else Steam's most recent login) when the user played. With neither it is left out, and the import result says why.
- **Pairing** with plugin files lives in `app/src/ui/data/local.ts`, by the rules above.
- **Which entry wins.** The demo entry is the match. Career, records and the Matches list drop a paired plugin entry. Aim views keep whichever entry carries the columns they need, so the plugin's per-shot aim error, target and on-screen state stay reachable. Nothing else is merged.
- **When the plugin adapter can go** (all three are needed):
  - every own match listed since recording shipped has a demo entry;
  - the line-of-sight oracle has judged the mesh model;
  - the plugin-only shot columns are merged or dropped.

## Settings and UI

- `AppSettings` gains `record_demos` (default true), `demo_cap_gb` (20), `demo_floor_gb` (10) and `demo_keep_last` (10). `botmode_set_recording` uses the same compare-and-swap as `set_launch_options`.
- **Bot Mode switch:** "Record demos (GOTV)", over the line "Each match is about 100 MB. Demos stay while they have clips worth rendering, then go." When the floor blocks recording, the launch dialog says so with the numbers, for example "Recording off this time: 9.4 GB free, floor 10 GB."
- **Data & settings, a Demos card** beside Valve:
  - space used against the cap as a bar, with free space and the floor;
  - how many demos are kept, by reason;
  - the cap, floor and keep-last as inputs;
  - a list with pin and delete;
  - the last failure, in plain words.
  - A `?demos=` mock scenario renders it for screenshots.
- **Host commands:**
  - `demos_status() -> DemoStore { folder, used, cap, floor, free, demos: DemoRow[] }`, where `DemoRow { id, map, createdUtc, size, state, pairedMatch, bestMomentScore, pinned, gameBuild, failReason }`;
  - `demos_set_policy`, `demos_pin(id, on)`, `demos_delete(id)` and `demos_sweep(keeps: {id, reason}[])`;
  - `import_local()`, `list_local()` and `read_local(path)`.
- **Clips** take a demo from either root: `JobEnv.demo_roots` holds `replays\` and `demos\`, and `ClipRequest.demo` names its root.

## Failure modes

- **Disk full mid-match:** the reserve check makes it unlikely, not impossible. It runs once, before the launch; another program can fill the disk during the match, and nothing in the app can stop that. The demo is then cut off where the disk ran out, and the extractor's truncated-demo path reads what it holds. With free space near zero, a truncated demo gets `disk_full_suspected` in the ledger. The plugin is hit by the same full disk. It rewrites its match file after every round through a temporary file and a rename (`plugin/Core/MatchWriter.cs`), so a write that fails leaves its last successful write in place: the rounds up to the one before the disk filled, in its in-progress folder until the match ends. If even its first write failed, there is no plugin file at all. Whatever survives on either side is listed with the rounds it holds and shown as unfinished; nothing can recover the rest of that match.
- **Crash:** the truncated-demo path.
- **GOTV did not start:** no new `auto-*.dem` after a session with recording on. The app says so and names the console fallback.
- **Extraction fails:** the ledger records the reason, the demo is kept, and the plugin entry serves the match.
- **A demo with no plugin file:** the demo stands alone.
- **A plugin file with no demo:** Clips says it needs a demo, worded for a local match.
- **A restart inside one demo:** `restart_in_demo`.
- **A second human in the match:** the POV comes from the user's SteamID64.
- **A CS2 update:** old demos can no longer make clips but can still be extracted. They are evicted first and marked.
- **A demo deleted by hand:** the ledger marks it `missing`.

## The supervised session

Nothing here has been run against the game. In order:
1. Note the free space. Check the switch, and the tokens in the launch dialog.
2. In the console, note `tv_enable`, `tv_autorecord`, `tv_maxclients`, `tv_snapshotrate` and `tv_delay`.
3. Play competitive with bots, MR12, on de_dust2. Watch for a GOTV row on the scoreboard.
4. Play to the win panel, leave, wait 30 s, and quit.
5. Check the demo's size and the import result:
   - the round count equals the plugin file's;
   - the freeze-delta join holds;
   - the win panel and the last `round_end` are present;
   - note the bytes per tick;
   - the plugin file shows 10 players and no GOTV.
6. Render the first supervised clip from this demo.
7. Test a restart.
8. Test a crash: end cs2.exe mid-round.
9. Optionally, record 3 minutes at `tv_snapshotrate 32`.

Sources (read 2026-11-06):
- https://shockbyte.com/help/knowledgebase/articles/how-to-enable-and-use-gotv-on-your-counter-strike-2-community-server
- https://www.4tmr.com/en-US/posts/21tMcqDL
- https://zap-hosting.com/guides/docs/cs2-cstv/
- https://www.noesis.gg/news/how-to-record-gotv-demos.html
- https://steamcommunity.com/app/730/discussions/0/1734336452581224347/
- https://leetify.com/blog/cs2-pov-demos/
- https://github.com/jhohen217/demoparser
