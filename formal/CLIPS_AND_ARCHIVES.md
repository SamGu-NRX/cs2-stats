# Clips launch protocol and pipeline archive lifecycle

Two state machines with real concurrency risk, model-checked at main `b5868a2`: the app's clips launch, settle and lock protocol (`ClipsLaunch.tla`) and the demo pipeline's archive lifecycle (`Archive.tla`). Exact counts for every configuration are in [RESULTS.md](RESULTS.md); counterexample traces are in [WITNESSES.md](WITNESSES.md). Each `.cfg` states its bounds; `make_configs.py` generates them. No application or extractor code changed.

## ClipsLaunch

### What it models

One render job with one clip, launched up to `N` times. The actors are:

- **App instances** sharing `clips.lock`. Each has its own mutex, launch steps, watcher threads and scans, and can crash at any step. A crash loses the mutex, the OS lock and the watchers; files and game processes stay.
- **Each launch's HLAE and CS2.** CS2 replaces `console.log` when it starts. The director starts the take, then ends it at the end tick or early.
- **The user**, who can start CS2 normally whenever no CS2 runs.

Abstractions:

- A launch's nonce is its number, and `console.log` is the session that last replaced it plus whether that session's director wrote `END ... why=end_tick`.
- Each launch makes at most one take, named after it. The app finds a take's owner the way `owner()` does: the highest-numbered launch whose record doesn't list the take.

| Model action | Code |
| --- | --- |
| `LaunchBegin` (settle earlier launches, refuse while one is pending, CS2 runs or a watcher runs) | [mod.rs:606](../app/src-tauri/src/clips/mod.rs#L606) `prepare_launch`, [612](../app/src-tauri/src/clips/mod.rs#L612), [618](../app/src-tauri/src/clips/mod.rs#L618) |
| `LaunchRecord`, `LaunchSpawn`, `LaunchPids`, `LaunchHandoff` | [mod.rs:652](../app/src-tauri/src/clips/mod.rs#L652) `start_launch` |
| `WatcherEnd` | [launch.rs:232](../app/src-tauri/src/clips/launch.rs#L232) `watch` |
| `Scan` (settle, then accept proven takes) | [mod.rs:438](../app/src-tauri/src/clips/mod.rs#L438) `settle_launches`, [426](../app/src-tauri/src/clips/mod.rs#L426) `newest_proven_take` |
| `SettledResult`, `Runs`, `Owner`, `Proven` | [launch.rs:496](../app/src-tauri/src/clips/launch.rs#L496) `settle`, [474](../app/src-tauri/src/clips/launch.rs#L474) `running`, [533](../app/src-tauri/src/clips/launch.rs#L533) `owner`, [539](../app/src-tauri/src/clips/launch.rs#L539) `take_proven` |

### Invariants

- `NoTakeWithoutEvidence`: no take is accepted unless its own launch's director recorded it to the end tick.
- `ResultTruthful`: a result says `ended` only when that launch's director wrote it.
- `OwnerIsCreator`: the owner the app infers for a take is the launch that made it.
- `OneLaunchAtATime`: at most one launch's HLAE or CS2 runs at a time.
- `EvidenceKept` (completeness): a launch whose director recorded the clip settles as `ended`.

### Results

The shipped code (`WatcherCheck` and `WatcherSettles` on, `HlaeCheck` off) passes every safety invariant without crashes. That holds with HLAE failing to start, `pids.json` failing to publish, two instances, and a user session; `ClipsLaunchSafety`, `TwoInstances` and `UserSessionSafety` pass.

Two counterexamples are findings:

- **`ClipsLaunchCrashGap` violates `OneLaunchAtATime`.**
  - **The trace:** launch 1 starts HLAE, and the app crashes before it publishes `pids.json`. The next launch settles launch 1 as damaged (no recorded HLAE, by design). Nothing is pending, no CS2 runs yet, and the restarted app has no watchers, so launch 2 starts while launch 1's HLAE runs.
  - **The window:** the crash must land between `spawn()` and the `pids.json` rename, and the relaunch must come before that HLAE starts CS2.
  - **Proposed fix (not applied):** also refuse while any `HLAE.exe` runs, as `prepare_launch` already does for `cs2.exe`. `ClipsLaunchHlaeCheck`, `ClipsLaunchHlaeCheckTwoInstances` and `ClipsLaunchWide` model that fix, and every invariant holds.
- **`ClipsLaunchUserSession` violates `EvidenceKept`.** The director records the clip to its end tick, CS2 and HLAE exit, and the user starts CS2 before the watcher's next two-second poll. That session replaces `console.log`, so the launch settles as stopped and the take never counts. The take is lost, never misattributed: `NoTakeWithoutEvidence` and `OwnerIsCreator` hold in the same configuration.

`ClipsLaunchLegacyWatcherCheck` turns off the check that #62 added (refusing a launch while a watcher runs) and reproduces the regression found in that PR's review: a launch whose `pids.json` failed is already settled as damaged, and a second launch starts beside its HLAE.

### Bounds and assumptions

- Two launches in most configurations, three in `ClipsLaunchWide`, with at most one instance crash and one user session.
- CS2 runs one instance at a time.
- Publishing a file is atomic (`rename_no_replace`).
- A director line carries only its own launch's nonce, and `console.log` holds only the current session's lines.
- Settling reads the process list and the log in one step. A user session starting between those two reads is the same lost-evidence case as the poll gap.
- The model doesn't cover the director's in-game behaviour, the tick alignment, or a forged line: the nonce check is assumed (it has unit tests in `launch.rs`).

## Archive

### What it models

The pipeline is one process, and the HTTP port admits one instance. Its main loop runs archive steps one at a time, and it can crash between any two. A restart forgets `self.archives` and `self.retried`, deletes leftover work folders and scans again. Each archive holds one whole map and one map recorded as two parts.

| Model action | Code |
| --- | --- |
| `Scan` | [demo_pipeline.py:967](../extractor/demo_pipeline.py#L967) `scan` |
| `Hash`, `Extract`, `Parse` | [1010](../extractor/demo_pipeline.py#L1010) `poll_hashes`, extraction and `finish_job` |
| `Stitch` | [1325](../extractor/demo_pipeline.py#L1325) `stitch_parts` |
| `Check` | [1302](../extractor/demo_pipeline.py#L1302), [1358](../extractor/demo_pipeline.py#L1358) `unaccounted` |
| `RemoveWork`, `RemoveRar`, `LedgerDone` | [1289](../extractor/demo_pipeline.py#L1289) `finish_archives`, [1314](../extractor/demo_pipeline.py#L1314), [1319](../extractor/demo_pipeline.py#L1319) |
| `Fail` | [1404](../extractor/demo_pipeline.py#L1404) `fail_archive` |
| `Cap` | [1376](../extractor/demo_pipeline.py#L1376) `enforce_parts_cap` |

### Invariants

- `NoUnaccountedDeletion`: once an archive's RAR is gone (and it wasn't dropped as truncated), its whole map is published. Its split map is either stitched, held with its parts, or expired by the cap with a row saying so.
- `ExpiredRecorded`: every deletion of held parts has an `expired` row.
- `CapSparesActive`: the cap never deletes the parts of an archive in flight.
- `FailedKept` (without crashes): an idle archive whose ledger says failed still has its RAR in `failed/`.
- `DeletedRecorded`: an archive whose RAR is gone has a done or dropped ledger row.

### Results

`ArchiveSafety` (two archives, one crash, `--retry-failed`, parts-cap pressure, failing and truncated parses, stitches that leave no complete map) and `ArchiveWide` (three archives, one crash, with symmetry reduction) pass `NoUnaccountedDeletion`, `ExpiredRecorded` and `CapSparesActive`. `ArchiveNoCrash` also passes `FailedKept` and `DeletedRecorded`.

`ArchiveCrashLedger` violates `DeletedRecorded`. A crash between deleting the RAR ([1314](../extractor/demo_pipeline.py#L1314), or a retried failure's folder at [1312](../extractor/demo_pipeline.py#L1312)) and appending the done row ([1319](../extractor/demo_pipeline.py#L1319)) leaves the maps published but no done row. For a retried failure, the last row even says failed. No data is lost; the ledger is wrong about that archive. Writing the done row before deleting the RAR would close it, with the restart then treating a done archive whose RAR is still present as finished.

`ArchiveLegacyNoCheck` skips the unaccounted check and violates `NoUnaccountedDeletion`: a stitch that left no complete map gets its RAR deleted. This shows the check carries the invariant.

### Bounds and assumptions

- Two or three archives and at most one crash.
- A worker's outcome is one value per archive.
- An ok whole map is published by its worker before the archive finishes.
- `due_for_retry` is assumed true for a failed archive.
- `replace_old_extractions`, version folders, CURRENT and readers are left out; `Publish.tla` and `Pipeline.tla` cover them.
- The cap may run whenever any archive is in flight, which is more often than the code (only inside `stitch_parts`), so its safety results are stronger than needed.
