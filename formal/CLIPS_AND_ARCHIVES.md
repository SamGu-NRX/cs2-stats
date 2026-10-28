# Clips launch protocol and pipeline archive lifecycle

Two state machines with real concurrency risk, model-checked at main `b5868a2`: the app's clips launch, settle and lock protocol (`ClipsLaunch.tla`) and the demo pipeline's archive lifecycle (`Archive.tla`). Exact counts for every configuration are in [RESULTS.md](RESULTS.md); counterexample traces are in [WITNESSES.md](WITNESSES.md). Each `.cfg` states its bounds; `make_configs.py` generates them. No application or extractor code changed. Proposed fixes appear in the models as switches that are off for the shipped code.

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
- `EvidenceKept`: a launch whose director recorded the clip, once settled, settles as `ended`. It is a state invariant about what a settled result says, not liveness. It doesn't claim that a launch settles at all, only that a settled one doesn't lose the director's evidence.

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

The pipeline is one process, and the HTTP port admits one instance. Its main loop is single-threaded:

- `finish_archives` and `fail_archive` each run one archive's block to its end before touching another archive, and `enforce_parts_cap` and `enforce_failed_cap` run inside such a block.
- Only the waiting phases (hashing, pending, extracting, parsing) interleave across archives.
- A crash can come between any two steps. It loses `self.archives`, `self.retried` and any cap in progress; a restart deletes leftover work folders and scans again.
- The user may download a deleted archive again.

Each archive holds one whole map and one map recorded as two parts.

| Model action | Code (main `b5868a2`) |
| --- | --- |
| `Scan`: a downloads RAR whose last row is not done or failed; with `--retry-failed`, a `failed/` RAR not yet tried in this run, even before its ledger row exists | [demo_pipeline.py:974-982](../extractor/demo_pipeline.py#L974) |
| `Hash`, `Extract`, `Parse` | [1010](../extractor/demo_pipeline.py#L1010) `poll_hashes`, extraction and `finish_job` |
| `Stitch`, `Check` | [1325](../extractor/demo_pipeline.py#L1325) `stitch_parts`, [1302](../extractor/demo_pipeline.py#L1302), [1358](../extractor/demo_pipeline.py#L1358) `unaccounted` |
| `RemoveWork`, `RemoveRar`, `LedgerDone` | [1289](../extractor/demo_pipeline.py#L1289) `finish_archives`, [1314](../extractor/demo_pipeline.py#L1314), [1319](../extractor/demo_pipeline.py#L1319) |
| `FailHold`, `FailDrop`, `FailDelete`, `FailMove`, `FailWrite` (a fresh failure joins `self.retried`), `FailLedger` | [1404-1458](../extractor/demo_pipeline.py#L1404) `fail_archive`, [1450](../extractor/demo_pipeline.py#L1450) |
| `CapFirst`, `CapSecond`: delete the held parts, then write the expired row | [1376-1403](../extractor/demo_pipeline.py#L1376) `enforce_parts_cap`, [1390](../extractor/demo_pipeline.py#L1390), [1397](../extractor/demo_pipeline.py#L1397) |
| `EvictRecord`, `EvictDelete`: the `failed_dropped.jsonl` row, then the folder goes; the ledger keeps saying failed | [1492-1510](../extractor/demo_pipeline.py#L1492) `enforce_failed_cap` |

Three proposed fixes are switches, off for the shipped code:

- `LedgerFirst`: the done row before the RAR goes, and a start deletes a done archive's leftover RAR.
- `ExpiryRowFirst`: the expired row before the parts go.
- `EvictionFixed`: `enforce_failed_cap` skips kept failures still in flight and writes a ledger row before deleting.

### Invariants

- `NoUnaccountedDeletion`: an archive whose RAR is gone has its whole map published and its split map stitched, expired with a row, or held with its parts. The exception is an archive deleted on purpose with its maps unaccounted, which `failed_dropped.jsonl` must record: a truncated failure, or a kept failure evicted by the cap.
- `ExpiredRecorded`: deleted held parts always have their expired row, except between the cap's two steps.
- `CapSparesActive`: the parts cap never touches an archive in flight.
- `FailedKept`: a failure whose last row says failed still has its RAR, unless `failed_dropped.jsonl` records its deletion.
- `DeletedRecorded`: an archive whose RAR is gone has a done row or a `failed_dropped.jsonl` record. No archive ends up published with no row.
- `EvictedRedownloadable`: after the cap evicts a kept failure, a new download of that archive is extracted, not skipped because its last ledger row says failed.

### Results

`ArchiveSafety` (shipped code, two archives, no crash, one re-download, `--retry-failed`, both caps under pressure, failing, truncated and broken stitches) passes every invariant except `EvictedRedownloadable`, which fails without any crash.

These counterexamples are findings in the shipped code:

- **`ArchiveEviction` violates `EvictedRedownloadable`.** `enforce_failed_cap` deletes a kept failure but leaves its ledger saying failed, so a later download of the same archive is skipped forever. The proposed fix also skips kept failures that are in flight. Without that, a retry in flight can lose its folder, fail again, and leave the same state; TLC found that case with only the ledger row added.
- **`ArchiveCrashLedger` violates `DeletedRecorded`.** A crash between deleting the RAR ([1314](../extractor/demo_pipeline.py#L1314), or a retried failure's folder at [1312](../extractor/demo_pipeline.py#L1312)) and appending the done row ([1319](../extractor/demo_pipeline.py#L1319)) leaves the maps published with no done row.
- **`ArchiveCrashExpiry` violates `ExpiredRecorded`.** A crash between deleting held parts ([1390](../extractor/demo_pipeline.py#L1390)) and writing their expired row ([1397](../extractor/demo_pipeline.py#L1397)) leaves the parts gone and `parts.jsonl` still saying held, with no record of the deletion.

`ArchiveFixed` turns on all three proposed fixes, with one crash, and passes every invariant. `ArchiveWide` checks the same with three archives and symmetry reduction. `ArchiveLegacyNoCheck` skips the unaccounted check and violates `NoUnaccountedDeletion`, which shows that check carries the invariant.

### Bounds, assumptions and exclusions

- Two archives (three in `ArchiveWide`), at most one crash and one re-download.
- A worker's outcome is one value per archive.
- An ok whole map is published by its worker before the archive finishes.
- `due_for_retry` is assumed true for a kept failure.
- The ledger is keyed by archive, though the code keys a retried failure by its `failed/` folder name.
- Recovery at a start is modelled as possible whenever the archive is not in flight, a superset of "at a start". The code also deletes only a file matching the done row's size and SHA-256.
- **Double publication is not covered:** "published" is one boolean per map. Versions, CURRENT, readers and replacing older extractions are in `Publish.tla` and `Pipeline.tla`, not here.
