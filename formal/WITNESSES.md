# Concrete TLC witnesses

Generated state differences from the retained TLC logs, with unchanged fields omitted. These are actual TLC traces, not illustrative schedules. Full logs are regenerated under ignored `results/`. The initial state is defined by each linked config and its module. `0` is the old version, `1`/`2` are fresh extraction nonces; `other` can be `damages.parquet`. The `match` unit includes the rating helper's `player_rounds` layout requirement. Code locations and witness interpretation are in [AUDIT.md](AUDIT.md).

Writer `pc`: 0 not started; 1 mkdir; 2 first table; 3 remaining tables; 4 schema reads passed; 5 manifest listing captured; 6 COMPLETE written; 7 folder renamed; 8 pointer staged; 9 CURRENT replaced; 11 RETIRED unlinked / finished; -1 failed. `ppc`/`cached`/`pending` are each pruner's independent state.

## ArchiveCrashExpiry

Violated `ExpiredRecorded`. [Bounds](ArchiveCrashExpiry.cfg).

```text
1. Initial (see the module's Init)
2. Scan: phase=<<"idle", "hashing">>
3. Scan: phase=<<"hashing", "hashing">>
4. Hash: phase=<<"pending", "hashing">>
5. Extract: phase=<<"extracting", "hashing">>; work=<<TRUE, FALSE>>
6. Parse: phase=<<"parsing", "hashing">>; outcome=<<"bad", "none">>
7. Hash: phase=<<"parsing", "pending">>
8. Extract: phase=<<"parsing", "extracting">>; work=<<TRUE, TRUE>>
9. Parse: phase=<<"parsing", "parsing">>; outcome=<<"bad", "ok">>; parts=<<FALSE, TRUE>>; whole=<<FALSE, TRUE>>
10. Stitch: phase=<<"parsing", "check">>; rows=<<{}, {"held"}>>; split=<<"none", "held">>
11. Check: phase=<<"parsing", "work">>
12. RemoveWork: phase=<<"parsing", "ledger">>; work=<<TRUE, FALSE>>
13. LedgerDone: phase=<<"parsing", "rar">>; ledger=<<"none", "done">>
14. RemoveRar: phase=<<"parsing", "idle">>; rar=<<"downloads", "gone">>
15. ToFail: phase=<<"fhold", "idle">>
16. CapFirst: parts=<<FALSE, FALSE>>; capPending={2}; unrecorded={2}
17. Crash: phase=<<"idle", "idle">>; work=<<FALSE, FALSE>>; capPending={}; crashes=1
```

## ArchiveCrashLedger

Violated `DeletedRecorded`. [Bounds](ArchiveCrashLedger.cfg).

```text
1. Initial (see the module's Init)
2. Scan: phase=<<"hashing", "idle">>
3. Hash: phase=<<"pending", "idle">>
4. Extract: phase=<<"extracting", "idle">>; work=<<TRUE, FALSE>>
5. Parse: phase=<<"parsing", "idle">>; outcome=<<"ok", "none">>; parts=<<TRUE, FALSE>>; whole=<<TRUE, FALSE>>
6. Stitch: phase=<<"check", "idle">>; rows=<<{"held"}, {}>>; split=<<"held", "none">>
7. Check: phase=<<"work", "idle">>
8. RemoveWork: phase=<<"rar", "idle">>; work=<<FALSE, FALSE>>
9. RemoveRar: phase=<<"ledger", "idle">>; rar=<<"gone", "downloads">>
10. Crash: phase=<<"idle", "idle">>; crashes=1
```

## ArchiveEviction

Violated `EvictedRedownloadable`. [Bounds](ArchiveEviction.cfg).

```text
1. Initial (see the module's Init)
2. Scan: phase=<<"hashing", "idle">>
3. Hash: phase=<<"pending", "idle">>
4. Extract: phase=<<"extracting", "idle">>; work=<<TRUE, FALSE>>
5. Parse: phase=<<"parsing", "idle">>; outcome=<<"bad", "none">>
6. ToFail: phase=<<"fhold", "idle">>
7. FailHold: phase=<<"fmove", "idle">>; rows=<<{"held"}, {}>>; split=<<"held", "none">>
8. FailMove: phase=<<"fwrite", "idle">>; rar=<<"failed", "downloads">>
9. FailWrite: phase=<<"fledger", "idle">>; work=<<FALSE, FALSE>>; retried={1}
10. FailLedger: phase=<<"fcap", "idle">>; ledger=<<"failed", "none">>
11. EvictRecord: dropped=<<TRUE, FALSE>>; evictPending={1}
12. EvictDelete: rar=<<"gone", "downloads">>; evicted=<<TRUE, FALSE>>; evictPending={}
13. FailDone: phase=<<"idle", "idle">>
```

## ArchiveLegacyNoCheck

Violated `NoUnaccountedDeletion`. [Bounds](ArchiveLegacyNoCheck.cfg).

```text
1. Initial (see the module's Init)
2. Scan: phase=<<"hashing", "idle">>
3. Hash: phase=<<"pending", "idle">>
4. Extract: phase=<<"extracting", "idle">>; work=<<TRUE, FALSE>>
5. Parse: phase=<<"parsing", "idle">>; outcome=<<"ok", "none">>; parts=<<TRUE, FALSE>>; whole=<<TRUE, FALSE>>
6. Stitch: phase=<<"check", "idle">>; parts=<<FALSE, FALSE>>; rows=<<{"stitched"}, {}>>; split=<<"broken", "none">>
7. Check: phase=<<"work", "idle">>
8. RemoveWork: phase=<<"rar", "idle">>; work=<<FALSE, FALSE>>
9. RemoveRar: phase=<<"ledger", "idle">>; rar=<<"gone", "downloads">>
```

## ClipsLaunchCrashGap

Violated `OneLaunchAtATime`. [Bounds](ClipsLaunchCrashGap.cfg).

```text
1. Initial (see the module's Init)
2. LaunchBegin: osLock="A"; lpc=[A |-> [step |-> "record", n |-> 1]]; busy=[A |-> "launch"]
3. LaunchRecord: lpc=[A |-> [step |-> "spawn", n |-> 1]]; rec=<<TRUE, FALSE>>
4. LaunchSpawn: lpc=[A |-> [step |-> "pids", n |-> 1]]; hlae=<<"running", "none">>
5. Crash: osLock="none"; lpc=[A |-> [step |-> "idle", n |-> 0]]; crashes=1; busy=[A |-> "idle"]
6. LaunchBegin: osLock="A"; lpc=[A |-> [step |-> "record", n |-> 2]]; result=<<"damaged", "none">>; busy=[A |-> "launch"]
7. LaunchRecord: lpc=[A |-> [step |-> "spawn", n |-> 2]]; rec=<<TRUE, TRUE>>
8. LaunchSpawn: lpc=[A |-> [step |-> "pids", n |-> 2]]; hlae=<<"running", "running">>
```

## ClipsLaunchLegacyWatcherCheck

Violated `OneLaunchAtATime`. [Bounds](ClipsLaunchLegacyWatcherCheck.cfg).

```text
1. Initial (see the module's Init)
2. LaunchBegin: osLock="A"; lpc=[A |-> [step |-> "record", n |-> 1]]; busy=[A |-> "launch"]
3. LaunchRecord: lpc=[A |-> [step |-> "spawn", n |-> 1]]; rec=<<TRUE, FALSE>>
4. LaunchSpawn: lpc=[A |-> [step |-> "pids", n |-> 1]]; hlae=<<"running", "none">>
5. LaunchPids: lpc=[A |-> [step |-> "handoff", n |-> 1]]; result=<<"damaged", "none">>; damage={1}
6. LaunchHandoff: running=[A |-> 1]; lpc=[A |-> [step |-> "idle", n |-> 0]]; watchers=[A |-> {1}]; busy=[A |-> "idle"]
7. LaunchBegin: lpc=[A |-> [step |-> "record", n |-> 2]]; busy=[A |-> "launch"]
8. LaunchRecord: lpc=[A |-> [step |-> "spawn", n |-> 2]]; rec=<<TRUE, TRUE>>
9. LaunchSpawn: lpc=[A |-> [step |-> "pids", n |-> 2]]; hlae=<<"running", "running">>
```

## ClipsLaunchUserSession

Violated `EvidenceKept`. [Bounds](ClipsLaunchUserSession.cfg).

```text
1. Initial (see the module's Init)
2. LaunchBegin: osLock="A"; lpc=[A |-> [step |-> "record", n |-> 1]]; busy=[A |-> "launch"]
3. LaunchRecord: lpc=[A |-> [step |-> "spawn", n |-> 1]]; rec=<<TRUE, FALSE>>
4. LaunchSpawn: lpc=[A |-> [step |-> "pids", n |-> 1]]; hlae=<<"running", "none">>
5. LaunchPids: lpc=[A |-> [step |-> "handoff", n |-> 1]]; pids=<<TRUE, FALSE>>
6. LaunchHandoff: running=[A |-> 1]; lpc=[A |-> [step |-> "idle", n |-> 0]]; watchers=[A |-> {1}]; busy=[A |-> "idle"]
7. Cs2Start: log=[owner |-> 1, ended |-> FALSE]; cs2=<<"running", "none">>
8. Record: director=<<"recording", "idle">>; takes={1}
9. EndClip: log=[owner |-> 1, ended |-> TRUE]; director=<<"ended", "idle">>
10. Cs2Exit: cs2=<<"exited", "none">>
11. UserStart: log=[owner |-> 0, ended |-> FALSE]; userCs2=TRUE; sessions=1
12. HlaeExit: hlae=<<"exited", "none">>
13. UserQuit: userCs2=FALSE
14. LaunchBegin: result=<<"stopped", "none">>
```

## PipelineLegacyIdentity

Violated `ReplacementBeforeDelete`. [Bounds](PipelineLegacyIdentity.cfg).

```text
1. Initial: pc="publish"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="check"; valid=TRUE; job=TRUE; jobVersion="new"
3. pc="retireStage"; ok=TRUE; liveVersion="new"
4. pc="retireReplace"; staged=TRUE
5. pc="delete"; oldMarker="replaced"; staged=FALSE
6. pc="queueOpen"; oldData=FALSE
```

## PipelineLegacyInPlace

Violated `InPlaceVersionSafe`. [Bounds](PipelineLegacyInPlace.cfg).

```text
1. Initial: pc="publish"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="check"; valid=TRUE; job=TRUE; jobVersion="new"
3. pc="retireStage"; ok=TRUE; liveVersion="new"
4. valid=FALSE; invalidated=TRUE; liveVersion="none"
5. pc="retireReplace"; staged=TRUE; badDecision=TRUE
```

## PluginAfterWin

Violated `NoCaptureAfterWin`. [Bounds](PluginAfterWin.cfg).

```text
1. Initial: map=0; live=FALSE
2. NewMap: map=1; liveMap=TRUE
3. Attach: attached=TRUE; probe=TRUE
4. StartCapture: capture=1; capturing=TRUE
5. Win: win=TRUE
6. EndCapture: capturing=FALSE
7. StartCapture: capture=2; capturing=TRUE; startedAfterWin=TRUE
```

## PluginHotReload

Violated `FailureSticky`. [Bounds](PluginHotReload.cfg).

```text
1. Initial: map=0; live=FALSE
2. NewMap: map=1; liveMap=TRUE
3. Attach: attached=TRUE; failed=TRUE; failedMap=1; reported=TRUE
4. HotReload: attached=FALSE; reloads=1
5. Attach: attached=TRUE; probe=TRUE; failed=FALSE; reported=FALSE
```

## PluginLateFreeze

Violated `NoPostFinalizeLive`. [Bounds](PluginLateFreeze.cfg).

```text
1. Initial: map=0; live=FALSE
2. NewMap: map=1; liveMap=TRUE
3. Attach: attached=TRUE; probe=TRUE
4. StartCapture: capture=1; capturing=TRUE
5. Begin: round=1; phase="freeze"; active=TRUE
6. Finalize: phase="sealed"; finalized=TRUE; seals=1
7. FreezeEnd: phase="live"; live=TRUE; sources={"los"}
```

## PublishFreshCrash

Violated `CrashAvailable`. [Bounds](PublishFreshCrash.cfg).

```text
1. Initial: loc=(0 :> "none" @@ 1 :> "none"); marker="none"; current=-1; pc=<<0>>
2. owner=1; loc=(0 :> "none" @@ 1 :> "tmp"); exists=TRUE; pc=<<1>>
3. Crash: crashed=TRUE
```

## PublishManual

Violated `CrashAvailable`. [Bounds](PublishManual.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "none" @@ 1 :> "none"); files=(0 :> {} @@ 1 :> {}); manual=TRUE
3. Crash: crashed=TRUE
```

## PublishPruneDangling

Violated `temporal`. [Bounds](PublishPruneDangling.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "version"); marker="none"; current=1; pc=<<11>>
2. loc=(0 :> "version" @@ 1 :> "none"); files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {}); manual=TRUE
3. locks={}
4. owner=2; ppc=<<"branch">>
5. ppc=<<"cache">>
6. ppc=<<"idle">>
7. Stuttering
Then stutter forever (no further state changes).
```

## PublishPruneOneShot

Violated `temporal`. [Bounds](PublishPruneOneShot.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "version"); marker="none"; current=1; pc=<<11>>
2. owner=2; ppc=<<"branch">>; passes=<<1>>
3. ppc=<<"cache">>
4. ppc=<<"list">>; cached=<<1>>
5. ppc=<<"delete">>; pending=<<{<<0, "version">>}>>
6. files=(0 :> {"match", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"})
7. files=(0 :> {"match"} @@ 1 :> {"match", "other", "COMPLETE"})
8. pending=<<{}>>; lockedPass=<<TRUE>>
9. locks={}
10. owner=0; ppc=<<"idle">>
11. Stuttering
Then stutter forever (no further state changes).
```

## PublishRatingBinding

Violated `RatingBindsTarget`. [Bounds](PublishRatingBinding.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. owner=1; loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. rpc="pointer"
11. rpc="validate"; chosen=0
12. current=1; staged={}; pc=<<9>>
13. rpc="stat"
14. checked={"match"}
15. rpc="target"; checked={"match", "other"}
16. rpc="open"; target=1
17. locks={<<0, "match">>}; loaded=<<0>>
18. locks={<<0, "match">>, <<0, "other">>}; rpc="finish"; loaded=<<0, 0>>
19. rpc="done"; badBinding=TRUE; returned=TRUE
```

## PublishRatingResolveError

Violated `ReaderSucceeds`. [Bounds](PublishRatingResolveError.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. owner=1; loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. rpc="pointer"
11. rpc="validate"; chosen=0
12. current=1; staged={}; pc=<<9>>
13. pc=<<10>>
14. owner=0; pc=<<11>>
15. owner=2; ppc=<<"branch">>; passes=<<1>>
16. ppc=<<"cache">>
17. ppc=<<"list">>; cached=<<1>>
18. ppc=<<"delete">>; pending=<<{<<0, "version">>}>>
19. files=(0 :> {"other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"})
20. rpc="error"; badValidation=TRUE; readerError=TRUE
```

## PublishRatingRetryExhausted

Violated `ReaderSucceeds`. [Bounds](PublishRatingRetryExhausted.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none" @@ 2 :> "none"); marker="none"; current=0; pc=<<0, 0>>
2. owner=1; loc=(0 :> "version" @@ 1 :> "tmp" @@ 2 :> "none"); pc=<<1, 0>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"} @@ 2 :> {}); pc=<<2, 0>>
4. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"} @@ 2 :> {} ); pc=<<3, 0>>
5. pc=<<4, 0>>
6. pc=<<5, 0>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {} ); pc=<<6, 0>>
8. loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "none"); pc=<<7, 0>>
9. staged={1}; pc=<<8, 0>>
10. rpc="pointer"
11. rpc="validate"; chosen=0
12. rpc="stat"
13. checked={"match"}
14. rpc="target"; checked={"match", "other"}
15. rpc="open"; target=0
16. current=1; staged={}; pc=<<9, 0>>
17. pc=<<10, 0>>
18. owner=0; pc=<<11, 0>>
19. owner=2; loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "tmp"); pc=<<11, 1>>
20. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match"} ); pc=<<11, 2>>
21. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match", "other"} ); pc=<<11, 3>>
22. pc=<<11, 4>>
23. pc=<<11, 5>>
24. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match", "other", "COMPLETE"} ); pc=<<11, 6>>
25. loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "version"); pc=<<11, 7>>
26. staged={2}; pc=<<11, 8>>
27. locks={<<0, "match">>}; loaded=<<0>>
28. locks={<<0, "match">>, <<0, "other">>}; rpc="finish"; loaded=<<0, 0>>
29. rpc="missing"
30. locks={}; rpc="marker"; chosen=-1; target=-1; loaded=<<>>; checked={}; attempt=2
31. rpc="pointer"
32. rpc="validate"; chosen=1
33. rpc="stat"
34. checked={"match"}
35. rpc="target"; checked={"match", "other"}
36. rpc="open"; target=1
37. current=2; staged={}; pc=<<11, 9>>
38. locks={<<1, "match">>}; loaded=<<1>>
39. locks={<<1, "match">>, <<1, "other">>}; rpc="finish"; loaded=<<1, 1>>
40. rpc="missing"
41. locks={}; rpc="error"; chosen=-1; target=-1; loaded=<<>>; checked={}; readerError=TRUE
```

## PublishRetiredCrash

Violated `CrashAvailable`. [Bounds](PublishRetiredCrash.cfg).

```text
1. Initial: loc=(0 :> "version"); marker="replaced"; current=0; pc=<< >>
2. owner=1; ppc=<<"branch">>; passes=<<1>>
3. ppc=<<"list">>; retiredBranch=<<TRUE>>
4. ppc=<<"delete">>; pending=<<{<<-1, "CURRENT">>, <<0, "version">>}>>
5. current=-1; pending=<<{<<0, "version">>}>>
6. files=(0 :> {"other", "COMPLETE"})
7. files=(0 :> {"COMPLETE"})
8. files=(0 :> {})
9. loc=(0 :> "none"); pending=<<{}>>
10. ppc=<<"unlink">>
11. marker="none"; ppc=<<"rmdir">>
12. Crash: crashed=TRUE
```

## PublishStrictWithdrawal

Violated `StrictWithdrawal`. [Bounds](PublishStrictWithdrawal.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="stale: reason"; current=0; pc=<<0>>
2. owner=1; loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. current=1; staged={}; pc=<<9>>
11. marker="none"; pc=<<10>>
```
