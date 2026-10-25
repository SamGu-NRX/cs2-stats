# TLA+ model checks

`Capture.tla` models the BotMatchStats round lifecycle, round-result finalization, worker queue, atomic `.tmp` replacement, hot reload, generation-tagged scans, stale-file abandonment, restart identity changes, map end, human disconnect, and remembered win-panel state. It stores round indices as a set because `MatchStore.SetRound` replaces by `ri`; event payloads and column values are abstracted to one `eventSeen` bit. A reload interrupts the open round and resumes it as partial, matching `Recorder.Flush` and `Resume`. A rejected resume starts a new scan and cannot start capture after the match has ended. The worker has separate `tmp`, `ready`, publish, and cleanup states, so an on-disk file becomes visible only after encoding.

`Calls.tla` models the rewritten BotBuy call state, buy-time versus pending calls, halftime clearing, buy-zone gating, native and plugin purchases, handle-keyed `PurchaseLedger` entries, dropped or replaced handles, deferred callbacks carrying round and handle, refunds, rich-bot preservation, and round reset. Every bot gun purchase reaches the ledger; the model no longer filters entries by a human-team set. It abstracts item prices to primary, pistol, armor, and utility classes.

Neither model covers CS2 engine behavior, CounterStrikeSharp callback ordering outside the modeled interleavings, rendering, gzip or JSON parser implementation, metric arithmetic, weapon preference details, or actual player/team enumeration. The models treat atomic rename and entity removal as abstract steps and do not model filesystem crashes, an unload timeout that drops queued work, or engine-side weapon identity bugs.

## Rerun

Java 21 and `curl` are required. `formal/tools/` is ignored. The checked-in runner pins the official TLA+ v1.7.4 release by SHA-256.

```text
cd "C:\Users\sgu07\Programming Projects\cs2-stats\formal"
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

All runs below used the pinned jar and four TLC workers. No counterexample was produced.

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
