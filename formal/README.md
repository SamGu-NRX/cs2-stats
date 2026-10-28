# TLA+ model checks

## Clips launch protocol and pipeline archive lifecycle

[CLIPS_AND_ARCHIVES.md](CLIPS_AND_ARCHIVES.md) covers two later models, with code mappings, bounds,
findings and assumptions; their counts are in RESULTS.md with the rest.

- `ClipsLaunch.tla` checks the app's clips launch, settle and lock protocol: two app instances on
  `clips.lock`, crashes at every launch step, HLAE and CS2 outside the app, the watcher, scans, a normal CS2
  session replacing `console.log`, and take ownership inferred from launch records.
- `Archive.tla` checks the demo pipeline's archive lifecycle from scan to the ledger: stitching or holding
  split maps, the unaccounted check, each step of a failure, `--retry-failed`, the parts cap, the
  failed-folder cap's eviction, re-downloads, and a crash between any two steps.

Neither model covers double publication: in `Archive.tla` a map's publication is one boolean, and versions,
CURRENT and replacement are checked by `Publish.tla` and `Pipeline.tla` below. `EvidenceKept` in
`ClipsLaunch.tla` is a safety property (what a settled result says), not liveness. The other exclusions are
listed in CLIPS_AND_ARCHIVES.md.

```text
python -I formal/check_models.py --while-gaming ClipsLaunchSafety ArchiveSafety
```

## Publication, readers, pipeline recovery and engine callbacks

The audit is in [AUDIT.md](AUDIT.md): every requested invariant has a bounded
result or a counterexample, source `file:line` mapping, suggested fix, and stated
assumptions. Its round-2 table compares baseline `683e691` with extractor PR #22
head `5423886465055063ab9a73bdc2c61631483cf8b6` and plugin fix `0070cae`.
[RESULTS.md](RESULTS.md) contains exact state counts for every configuration.
[WITNESSES.md](WITNESSES.md) retains concrete TLC state differences.

- `Publish.tla` checks version folders, per-file COMPLETE manifests, CURRENT,
  RETIRED text, concurrent writers/pruners, per-file Windows locks, all three
  reader contracts, writer failure/retry, retirement, manual target deletion,
  process crashes, and pruning liveness.
- `Pipeline.tla` checks stale replacement in another archive, cached result
  validity, filename/size identity, `_dup` output paths, in-place version identity,
  needs_reextract queue rewriting and the completed-ledger refeed boundary.
- `MapGate.tla` checks cold launch, hot reload at the menu/in a match, menu ticks,
  entity readiness, map changes, scan replies, and teardown assumptions.
- `Plugin.tla` supplements Capture with LOS disable/reattach behavior, mid-round
  capture metadata and callback-order/finalization boundaries.

Both original race leads are confirmed. Additional findings include a missing
intended table being omitted from a newly generated COMPLETE manifest, loss of
unresolved queue rows, rating-helper retry/freshness limits, and plugin teardown
and mid-round LOS metadata gaps. MapGate's normal paths pass under explicit
engine assumptions. No extractor, plugin or application source was changed.

The largest publication run explores over five million distinct states with
two writers, an old version, a reader with one retry, and pruning. A separate
run explores two concurrent pruners. These are focused bounded configurations,
not a claim of exhaustive unbounded filesystem or engine verification. The Node
reader and external refeed implementation are absent at the audited revision;
their documented contracts and pipeline-facing assumptions are distinguished
from code findings in AUDIT.md.

From the repository root:

```text
python -I formal/check_models.py
python -I formal/report_models.py
python -I formal/reproduce.py
```

For the current extractor fix, fetch and verify the exact source head before the
replay (the replay also checks this SHA itself):

```text
git fetch origin pull/22/head:refs/remotes/origin/pr22-head
git -C "%CS2_FIXED_REPO%" rev-parse HEAD   # CS2_FIXED_REPO: a checkout of the fixed source
# expected: 5423886465055063ab9a73bdc2c61631483cf8b6
python -I formal/check_models.py --while-gaming
python -I formal/report_models.py
python -I formal/reproduce.py
```

The eight existing configurations were also rerun successfully as runner
regressions. To include them when regenerating the complete results table:

```text
python -I formal/check_models.py CaptureNormal CaptureReload CaptureReloadLive CaptureScanRace CallsSafety CallsRefund CallsRich CallsReset
python -I formal/report_models.py
```

The suite expects the documented counterexamples and returns nonzero for an
unexpected pass/failure or a TLC parsing/runtime error. `report_models.py`
refuses stale results using model/config SHA-256 hashes. Individual checks use
the existing runner, for example `python -I formal/run.py PublishCurrentRace`.
A counterexample intentionally gives that individual command a nonzero exit.
`make_configs.py` regenerates the checked-in bounds. Generated raw logs, TLC
states, replay data and the jar remain ignored; only models/configurations,
reviewed reports and reproduction tools are committed.

The default runner still refuses to run with CS2 open. During this audit CS2 was
running, so the complete suite was run explicitly with:

```text
python -I formal/check_models.py --while-gaming
```

That option uses one TLC worker, one active JVM processor, a 384 MB heap and
below-normal Windows process priority. The ordinary default remains four
workers and a 768 MB heap. `reproduce.py` requires Windows for its real
open-handle/partial-rmtree witness and stubs only parquet encoding/schema reads.

The old untracked `spec/` was removed after its checksum-matching jar was copied
to ignored `formal/tools/tla2tools.jar`. For a fresh checkout, obtain the pinned
jar before running:

```text
mkdir formal\tools
curl.exe -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -o formal\tools\tla2tools.jar
```

The runner verifies SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.

## Existing capture and purchase models

`Capture.tla` models the BotMatchStats round lifecycle, round-result finalization, worker queue, atomic `.tmp` replacement, hot reload, generation-tagged scans, stale-file abandonment, restart identity changes, map end, human disconnect, and remembered win-panel state. It stores round indices as a set because `MatchStore.SetRound` replaces by `ri`; event payloads and column values are abstracted to one `eventSeen` bit. A reload interrupts the open round and resumes it as partial, matching `Recorder.Flush` and `Resume`. A rejected resume starts a new scan and cannot start capture after the match has ended. The worker has separate `tmp`, `ready`, publish, and cleanup states, so an on-disk file becomes visible only after encoding.

`Calls.tla` models the rewritten BotBuy call state, buy-time versus pending calls, halftime clearing, buy-zone gating, native and plugin purchases, handle-keyed `PurchaseLedger` entries, dropped or replaced handles, deferred callbacks carrying round and handle, refunds, rich-bot preservation, and round reset. Every bot gun purchase reaches the ledger; the model no longer filters entries by a human-team set. It abstracts item prices to primary, pistol, armor, and utility classes.

These two original models do not cover CS2 engine behavior, CounterStrikeSharp callback ordering outside the modeled interleavings, rendering, gzip or JSON parser implementation, metric arithmetic, weapon preference details, or actual player/team enumeration. They treat atomic rename and entity removal as abstract steps and do not model filesystem crashes, an unload timeout that drops queued work, or engine-side weapon identity bugs. The new models above address specific filesystem crashes and callback assumptions; their scope and remaining limits are stated separately in AUDIT.md. In particular, Capture's `RoundStart` guard assumes no capture starts after a remembered win; `PluginAfterWin` checks the real handler's weaker guard.

## Rerun

Java 21 and `curl` are required. `formal/tools/` is ignored. The checked-in runner pins the official TLA+ v1.7.4 release by SHA-256.

```text
cd formal
python -I run.py CaptureNormal
python -I run.py CaptureReload
python -I run.py CaptureReloadLive
python -I run.py CaptureScanRace
python -I run.py CallsSafety
python -I run.py CallsRefund
python -I run.py CallsRich
python -I run.py CallsReset
```

The runner refuses to start while `cs2.exe` is running and invokes TLC with `-workers 4`. Logs are written under `results/`; TLC state files go under ignored `states/`.

## Results

The historical runs below used the pinned jar and four TLC workers. No counterexample was produced in those configurations. New protocol results, including intentional violations, are in RESULTS.md.

| Configuration | States generated | Distinct states | Result | Checked properties |
| --- | ---: | ---: | --- | --- |
| `CaptureNormal` | 154,409 | 73,689 | PASS | `TypeOK`, `CompletedExactlyOnce`, `ReloadAccounted`, `Parseable`, `FinalAtMostOnce`, `SameMatchResume` |
| `CaptureReload` | 3,275 | 1,986 | PASS | `TypeOK`, `CompletedExactlyOnce`, `ReloadAccounted`, `Parseable`, `FinalAtMostOnce`, `SameMatchResume` |
| `CaptureReloadLive` | 621 | 483 | PASS | `TypeOK`, `NormalEventuallyFinal` |
| `CaptureScanRace` | 13,715 | 8,644 | PASS | `TypeOK`, `SameMatchResume` |
| `CallsSafety` | 2,188,882 | 441,987 | PASS | `TypeOK`, `NoDoubleRefund`, `NoMoneyCreated`, `PendingCorrectHalf`, `RoundStateReset`, `GiftedDroppedReplacedSafe`, `OldCallbackSafe`, `RichKeepsPurchases` |
| `CallsRefund` | 201,646 | 38,357 | PASS | `TypeOK`, `NoDoubleRefund`, `NoMoneyCreated`, `PendingCorrectHalf`, `RoundStateReset`, `GiftedDroppedReplacedSafe`, `OldCallbackSafe`, `RichKeepsPurchases` |
| `CallsRich` | 170,690 | 30,389 | PASS | `TypeOK`, `NoDoubleRefund`, `NoMoneyCreated`, `RichKeepsPurchases` |
| `CallsReset` | 90,102 | 22,631 | PASS | `TypeOK`, `RoundStateReset`, `NoDoubleRefund`, `NoMoneyCreated`, `PendingCorrectHalf`, `OldCallbackSafe` |

The formal traces map to `Lifecycle.AcceptResume` and `ScanStale` for generation and identity checks, `MatchOverAtResume` and the win-panel handler for remembered match end, `Recorder.Flush` and `MatchWriter` for interrupted partial rows and atomic publication, and `PurchaseLedger.Add`, `Undo`, `BotBuyPatch.IsSaving`, `ApplyCall`, and deferred `RefundGuns` for the purchase invariants. Production C# files were not modified.
