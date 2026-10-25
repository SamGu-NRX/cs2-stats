# TLA+ model checks

`Capture.tla` models the BotMatchStats round lifecycle, round-result finalization, worker queue, atomic `.tmp` replacement, hot reload, stale-file scan, restart detection, map end, and human disconnect. It stores round indices as a set because `MatchStore.SetRound` replaces by `ri`; event payloads and column values are abstracted to one `eventSeen` bit. A reload interrupts the open round and resumes it as partial, matching `Recorder.Flush` and `Resume`. The worker has separate `tmp`, `ready`, publish, and cleanup states, so an on-disk file becomes visible only after encoding.

`Calls.tla` models two bots, three rounds, team calls, buy-time versus pending calls, halftime clearing, native and plugin purchases, tracked items, refunds, and round reset. It abstracts item prices to primary, pistol, and armor classes. `Buy` is represented by a guarded purchase; native `item_purchase` can queue a next-frame refund. Inventory identity is a token, which makes duplicate refunds observable.

Neither model covers CS2 engine behavior, CounterStrikeSharp callback ordering outside the modeled interleavings, rendering, gzip or JSON parser implementation, metric arithmetic, weapon preference details, or actual player/team enumeration. The model also treats atomic rename as an abstract publish step and does not model filesystem crashes or an unload timeout that drops queued work.

## Rerun

Java 21 and `curl` are required. `formal/tools/` is ignored. The checked-in runner pins the official TLA+ v1.7.4 release by SHA-256.

```text
cd "C:\Users\<user>\Programming Projects\cs2-stats\formal"
python -I run.py CaptureNormal
python -I run.py CaptureReload
python -I run.py CaptureScanRace
python -I run.py CallsSafety
python -I run.py CallsRefund
python -I run.py CallsRich
python -I run.py CallsReset
```

The runner refuses to start while `cs2.exe` is running and invokes TLC with `-workers 4`. Logs are written under `results/`; TLC state files go under ignored `states/`. `CaptureReload` covers a mid-round reload and passes. `CaptureReloadLive` fails the normal-completion liveness property when reload overlaps the win-panel path. `CaptureScanRace` fails `SameMatchResume` when restart races the old scan response. `CallsReset` fails `RoundStateReset` because a queued next-frame refund survives `OnRoundStart`. `CallsRich` uses `$4500` initial money and passes `RichKeepsPurchases`. These traces expose current code paths rather than changes to the C# code.
