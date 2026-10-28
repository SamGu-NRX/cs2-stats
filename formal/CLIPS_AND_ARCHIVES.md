# Clips launch protocol and pipeline archive lifecycle

Two state machines with real concurrency risk, model-checked: the app's clips launch, settle and lock protocol (`ClipsLaunch.tla`) and the demo pipeline's archive lifecycle (`Archive.tla`). Exact counts for every configuration are in [RESULTS.md](RESULTS.md); counterexample traces are in [WITNESSES.md](WITNESSES.md). Each `.cfg` states its bounds; `make_configs.py` generates them. The models first ran against main `b5868a2` and found five gaps. The code now closes them. Each fix is a switch in its model, on for the shipped code, and a `Legacy` configuration turns it off and must still produce the counterexample. CI runs every configuration and fails if a `Legacy` one stops failing.

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
| `LaunchBegin` (settle earlier launches, refuse while one is pending, a watcher runs, CS2 runs or HLAE runs) | [mod.rs:606](../app/src-tauri/src/clips/mod.rs#L606) `prepare_launch`, [612](../app/src-tauri/src/clips/mod.rs#L612), [618](../app/src-tauri/src/clips/mod.rs#L618), [624](../app/src-tauri/src/clips/mod.rs#L624) |
| `LaunchRecord`, `LaunchSpawn`, `LaunchPids`, `LaunchHandoff` | [mod.rs:652](../app/src-tauri/src/clips/mod.rs#L652) `start_launch` |
| `WatcherEnd` | [launch.rs:237](../app/src-tauri/src/clips/launch.rs#L237) `watch` |
| `Scan` (settle, then accept proven takes) | [mod.rs:438](../app/src-tauri/src/clips/mod.rs#L438) `settle_launches`, [426](../app/src-tauri/src/clips/mod.rs#L426) `newest_proven_take` |
| `SettledResult`, `Runs`, `Owner`, `Proven` | [launch.rs:501](../app/src-tauri/src/clips/launch.rs#L501) `settle`, [479](../app/src-tauri/src/clips/launch.rs#L479) `running`, [538](../app/src-tauri/src/clips/launch.rs#L538) `owner`, [544](../app/src-tauri/src/clips/launch.rs#L544) `take_proven` |

### Invariants

- `NoTakeWithoutEvidence`: no take is accepted unless its own launch's director recorded it to the end tick.
- `ResultTruthful`: a result says `ended` only when that launch's director wrote it.
- `OwnerIsCreator`: the owner the app infers for a take is the launch that made it.
- `OneLaunchAtATime`: at most one launch's HLAE or CS2 runs at a time.
- `EvidenceKept`: a launch whose director recorded the clip, once settled, settles as `ended`. It is a state invariant about what a settled result says, not liveness. It doesn't claim that a launch settles at all, only that a settled one doesn't lose the director's evidence.

### Results

The shipped code (`WatcherCheck`, `WatcherSettles` and `HlaeCheck` on) passes every safety invariant with an instance crash at any step, HLAE failing to start, `pids.json` failing to publish, two instances, and a user session. `ClipsLaunchSafety`, `TwoInstances`, `UserSessionSafety`, `CrashGap` and `Wide` pass.

- **`ClipsLaunchCrashGap` passes since the HLAE check.** Before it, launch 1 could start HLAE and the app crash before publishing `pids.json`. The next launch settled launch 1 as damaged; nothing was pending, no CS2 ran yet and no watcher survived, so launch 2 started beside launch 1's HLAE. `prepare_launch` now refuses while any `HLAE.exe` runs, as it does for `cs2.exe`. `ClipsLaunchLegacyHlaeCheck` turns the check off and keeps finding that trace.
- **`ClipsLaunchUserSession` violates `EvidenceKept`, by design.** The director records the clip to its end tick, CS2 and HLAE exit, and the user starts CS2 before the watcher's next two-second poll. That session replaces `console.log`, so the launch settles as stopped and the take never counts. The take is lost, never misattributed: `NoTakeWithoutEvidence` and `OwnerIsCreator` hold in the same configuration. The Clips page's render dialog and its waiting note tell the user to keep CS2 closed until the page stops waiting.

`ClipsLaunchLegacyWatcherCheck` turns off both the HLAE check and the check that #62 added (refusing a launch while a watcher runs), without a crash, and reproduces the regression found in that PR's review: a launch whose `pids.json` failed is already settled as damaged, and a second launch starts beside its HLAE. The HLAE check alone also catches that schedule, so it comes off too.

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

| Model action | Code |
| --- | --- |
| `Scan`: a downloads RAR whose last row is not done or failed; with `--retry-failed`, a `failed/` RAR not yet tried in this run, even before its ledger row exists | [demo_pipeline.py:984-992](../extractor/demo_pipeline.py#L984) |
| `Hash`, `Extract`, `Parse` | [1020](../extractor/demo_pipeline.py#L1020) `poll_hashes`, extraction and `finish_job` |
| `Stitch`, `Check` | [1369](../extractor/demo_pipeline.py#L1369) `stitch_parts`, [1312](../extractor/demo_pipeline.py#L1312), [1402](../extractor/demo_pipeline.py#L1402) `unaccounted` |
| `RemoveWork`, `LedgerDone`, `RemoveRar` | [1299](../extractor/demo_pipeline.py#L1299) `finish_archives`, the row at [1328](../extractor/demo_pipeline.py#L1328), then the RAR at [1331](../extractor/demo_pipeline.py#L1331) |
| `Recover`: a done archive's leftover RAR is deleted at a start, if its size and SHA-256 match the row | [1339](../extractor/demo_pipeline.py#L1339) `recover_finished` |
| `FailHold`, `FailDrop`, `FailDelete`, `FailMove`, `FailWrite` (a fresh failure joins `self.retried`), `FailLedger` | [1461-1515](../extractor/demo_pipeline.py#L1461) `fail_archive`, [1507](../extractor/demo_pipeline.py#L1507) |
| `CapFirst`, `CapSecond`: write the expired row, then delete the held parts | [1420](../extractor/demo_pipeline.py#L1420) `enforce_parts_cap`, the row at [1446](../extractor/demo_pipeline.py#L1446), the parts at [1451](../extractor/demo_pipeline.py#L1451) |
| `EvictRecord`, `EvictDelete`: skip a failure being retried; write the `failed_dropped.jsonl` row and a `dropped` ledger row, then delete the folder | [1549](../extractor/demo_pipeline.py#L1549) `enforce_failed_cap`, [1557](../extractor/demo_pipeline.py#L1557), [1574](../extractor/demo_pipeline.py#L1574), [1579](../extractor/demo_pipeline.py#L1579) |

Three fixes are switches, on for the shipped code:

- `LedgerFirst`: the done row before the RAR goes, and a start deletes a done archive's leftover RAR.
- `ExpiryRowFirst`: the expired row before the parts go.
- `EvictionFixed`: `enforce_failed_cap` skips a kept failure being retried (except the archive failing now, which is no longer in flight) and writes a `dropped` ledger row before deleting.

### Invariants

- `NoUnaccountedDeletion`: an archive whose RAR is gone has its whole map published and its split map stitched, expired with a row, or held with its parts. The exception is an archive deleted on purpose with its maps unaccounted, which `failed_dropped.jsonl` must record: a truncated failure, or a kept failure evicted by the cap.
- `ExpiredRecorded`: deleted held parts always have their expired row, except between the cap's two steps.
- `CapSparesActive`: the parts cap never touches an archive in flight.
- `FailedKept`: a failure whose last row says failed still has its RAR, unless `failed_dropped.jsonl` records its deletion.
- `DeletedRecorded`: an archive whose RAR is gone has a done row or a `failed_dropped.jsonl` record. No archive ends up published with no row.
- `EvictedRedownloadable`: after the cap evicts a kept failure, a new download of that archive is extracted, not skipped because its last ledger row says failed.

### Results

The shipped code (`ArchiveSafety`: two archives, one crash, one re-download, `--retry-failed`, both caps under pressure, failing, truncated and broken stitches) passes every invariant, and so does `ArchiveWide` with three archives and symmetry reduction. `ArchiveEviction`, `ArchiveCrashLedger` and `ArchiveCrashExpiry` check the property each gap broke.

Each `Legacy` configuration turns one fix off and must keep failing, on the code as it was at `b5868a2`:

- **`ArchiveLegacyEviction` violates `EvictedRedownloadable`, without a crash.** `enforce_failed_cap` deleted a kept failure but left its ledger saying failed, so a later download of the same archive was skipped forever. A ledger row alone isn't enough: TLC then found the cap evicting a retried failure still in flight, which fails again and leaves the same state. Hence both halves of the fix.
- **`ArchiveLegacyLedgerOrder` violates `DeletedRecorded`.** A crash between deleting the RAR and appending the done row left the maps published with no done row.
- **`ArchiveLegacyExpiry` violates `ExpiredRecorded`.** A crash between deleting held parts and writing their expired row left the parts gone and `parts.jsonl` still saying held.
- **`ArchiveLegacyNoCheck`** skips the unaccounted check and violates `NoUnaccountedDeletion`, which shows that check carries the invariant.

### Bounds, assumptions and exclusions

- Two archives (three in `ArchiveWide`), at most one crash and one re-download.
- A worker's outcome is one value per archive.
- An ok whole map is published by its worker before the archive finishes.
- `due_for_retry` is assumed true for a kept failure.
- The ledger is keyed by archive, though the code keys a retried failure by its `failed/` folder name.
- Recovery at a start is modelled as possible whenever the archive is not in flight, a superset of "at a start". The code also deletes only a file matching the done row's size and SHA-256.
- The eviction's two appends (`failed_dropped.jsonl`, then the ledger) are one model step. A crash between them leaves the folder in place, and a later pass over the cap evicts it again.
- **Double publication is not covered:** "published" is one boolean per map. Versions, CURRENT, readers and replacing older extractions are in `Publish.tla` and `Pipeline.tla`, not here.
