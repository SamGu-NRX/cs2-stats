# Concrete TLC witnesses

Generated state differences from the retained TLC logs, with unchanged fields omitted. These are actual TLC traces, not illustrative schedules. Full logs are regenerated under ignored `results/`. The initial state is defined by each linked config and its module. `0` is the old version, `1`/`2` are fresh extraction nonces; `other` can be `damages.parquet`. The `match` unit includes the rating helper's `player_rounds` layout requirement. Code locations and witness interpretation are in [AUDIT.md](AUDIT.md).

Writer `pc`: 0 not started; 1 mkdir; 2 first table; 3 remaining tables; 4 schema reads passed; 5 manifest listing captured; 6 COMPLETE written; 7 folder renamed; 8 pointer staged; 9 CURRENT replaced; 11 RETIRED unlinked / finished; -1 failed. `ppc`/`cached`/`pending` are each pruner's independent state.

## MapGateEndThrows

Violated `NoMenuEntities`. [Bounds](MapGateEndThrows.cfg).

```text
1. Initial: live=FALSE; named=FALSE; map=0; gate=FALSE; awaiting=FALSE
2. EngineStart: live=TRUE; named=TRUE; map=1; pendingStart=TRUE
3. EntityReady: ready=TRUE
4. MapStart: gate=TRUE; pendingStart=FALSE
5. Housekeeping: needInit=FALSE; scan=TRUE
6. ScanReply: capturing=TRUE; roundLive=TRUE; scan=FALSE
7. MapEnd: gate=FALSE; ending=TRUE
8. EngineEnd: live=FALSE; named=FALSE; ready=FALSE; ending=FALSE
9. Housekeeping: badAccess=TRUE
```

## MapGateLateEnd

Violated `NoMenuEntities`. [Bounds](MapGateLateEnd.cfg).

```text
1. Initial: live=FALSE; named=FALSE; map=0; gate=FALSE; awaiting=FALSE
2. EngineStart: live=TRUE; named=TRUE; map=1; pendingStart=TRUE
3. MapStart: gate=TRUE; pendingStart=FALSE
4. EngineEnd: live=FALSE; named=FALSE
5. Housekeeping: badAccess=TRUE
```

## MapGateReloadDuringEnd

Violated `NoMenuEntities`. [Bounds](MapGateReloadDuringEnd.cfg).

```text
1. Initial: live=FALSE; named=FALSE; map=0; gate=FALSE; awaiting=FALSE
2. EngineStart: live=TRUE; named=TRUE; map=1; pendingStart=TRUE
3. MapStart: gate=TRUE; pendingStart=FALSE
4. MapEnd: gate=FALSE; ending=TRUE
5. Reload: reloads=1; awaiting=TRUE
6. Housekeeping: gate=TRUE; awaiting=FALSE
7. EngineEnd: live=FALSE; named=FALSE; ending=FALSE
8. Housekeeping: badAccess=TRUE
```

## MapGateStaleName

Violated `NoMenuEntities`. [Bounds](MapGateStaleName.cfg).

```text
1. Initial: live=FALSE; named=FALSE; map=0; gate=FALSE; awaiting=TRUE
2. EngineStart: live=TRUE; named=TRUE; map=1; pendingStart=TRUE
3. MapStart: gate=TRUE; awaiting=FALSE; pendingStart=FALSE
4. MapEnd: gate=FALSE; ending=TRUE
5. EngineEnd: live=FALSE; ending=FALSE
6. Reload: reloads=1; awaiting=TRUE
7. Housekeeping: gate=TRUE; awaiting=FALSE; badAccess=TRUE
```

## PipelineIdentity

Violated `ReplacementBeforeDelete`. [Bounds](PipelineIdentity.cfg).

```text
1. Initial: pc="publish"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="check"; valid=TRUE; job=TRUE
3. pc="retireStage"; ok=TRUE
4. pc="retireReplace"; staged=TRUE
5. pc="delete"; oldMarker="replaced"; staged=FALSE
6. pc="queueOpen"; oldData=FALSE
```

## PipelineLostReplacement

Violated `ReplacementBeforeDelete`. [Bounds](PipelineLostReplacement.cfg).

```text
1. Initial: pc="publish"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="check"; valid=TRUE; job=TRUE
3. pc="retireStage"; ok=TRUE
4. valid=FALSE; invalidated=TRUE
5. pc="retireReplace"; staged=TRUE
6. pc="delete"; oldMarker="replaced"; staged=FALSE
7. pc="queueOpen"; oldData=FALSE
```

## PipelineQueueCrash

Violated `CrashQueuePreserved`. [Bounds](PipelineQueueCrash.cfg).

```text
1. Initial: pc="publish"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="check"; valid=TRUE; job=TRUE
3. pc="retireStage"; ok=TRUE
4. pc="retireReplace"; staged=TRUE
5. pc="delete"; oldMarker="replaced"; staged=FALSE
6. pc="queueOpen"; oldData=FALSE
7. pc="queueWrite"; row=FALSE; otherRow=FALSE
8. Crash: crashed=TRUE
```

## PipelineRefeed

Violated `temporal`. [Bounds](PipelineRefeed.cfg).

```text
1. Initial: pc="scan"; valid=FALSE; oldMarker="stale: reason"; oldData=TRUE
2. pc="done"
3. Stuttering
Then stutter forever (no further state changes).
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

## PluginMidRoundError

Violated `FailureRecorded`. [Bounds](PluginMidRoundError.cfg).

```text
1. Initial: map=0; live=FALSE
2. NewMap: map=1; liveMap=TRUE
3. Attach: attached=TRUE; failed=TRUE; failedMap=1; reported=TRUE
4. StartCapture: capture=1; capturing=TRUE; reported=FALSE
5. BeginMidRound: round=1; phase="live"; active=TRUE; live=TRUE
```

## PluginMidRoundSource

Violated `LiveSourceRecorded`. [Bounds](PluginMidRoundSource.cfg).

```text
1. Initial: map=0; live=FALSE
2. NewMap: map=1; liveMap=TRUE
3. Attach: attached=TRUE; probe=TRUE
4. StartCapture: capture=1; capturing=TRUE
5. BeginMidRound: round=1; phase="live"; active=TRUE; live=TRUE
```

## PublishCrash

Violated `CrashAvailable`. [Bounds](PublishCrash.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. ppc=<<"branch">>; passes=<<1>>
11. ppc=<<"cache">>
12. ppc=<<"list">>; cached=<<0>>
13. current=1; staged={}; pc=<<9>>
14. ppc=<<"delete">>; pending=<<{<<1, "version">>}>>
15. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"other", "COMPLETE"})
16. Crash: crashed=TRUE
```

## PublishCurrentRace

Violated `CurrentValid`. [Bounds](PublishCurrentRace.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. ppc=<<"branch">>; passes=<<1>>
11. ppc=<<"cache">>
12. ppc=<<"list">>; cached=<<0>>
13. current=1; staged={}; pc=<<9>>
14. ppc=<<"delete">>; pending=<<{<<1, "version">>}>>
15. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"other", "COMPLETE"})
```

## PublishFreshCrash

Violated `CrashAvailable`. [Bounds](PublishFreshCrash.cfg).

```text
1. Initial: loc=(0 :> "none" @@ 1 :> "none"); marker="none"; current=-1; pc=<<0>>
2. loc=(0 :> "none" @@ 1 :> "tmp"); exists=TRUE; pc=<<1>>
3. Crash: crashed=TRUE
```

## PublishManual

Violated `CrashAvailable`. [Bounds](PublishManual.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "none" @@ 1 :> "none"); files=(0 :> {} @@ 1 :> {}); manual=TRUE
3. Crash: crashed=TRUE
```

## PublishNodeIncomplete

Violated `NoIncomplete`. [Bounds](PublishNodeIncomplete.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. ppc=<<"branch">>; passes=<<1>>
7. ppc=<<"cache">>
8. ppc=<<"list">>; cached=<<0>>
9. ppc=<<"delete">>; pending=<<{<<1, "tmp">>}>>
10. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"})
11. manifest=(0 :> {"match", "other"} @@ 1 :> {"match"}); pc=<<5>>
12. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "COMPLETE"}); pc=<<6>>
13. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
14. staged={1}; pc=<<8>>
15. current=1; staged={}; pc=<<9>>
16. rpc="pointer"
17. rpc="validate"; chosen=1
18. rpc="open"; badIncomplete=TRUE
```

## PublishNodePerFile

Violated `NoMix`. [Bounds](PublishNodePerFile.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. ppc=<<"branch">>; passes=<<1>>
11. ppc=<<"cache">>
12. rpc="pointer"
13. rpc="validate"; chosen=0
14. current=1; staged={}; pc=<<9>>
15. ppc=<<"list">>; cached=<<1>>
16. ppc=<<"delete">>; pending=<<{<<0, "version">>}>>
17. rpc="open"
18. files=(0 :> {"match", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"})
19. locks={<<0, "match">>}; loaded=<<0>>
20. rpc="missing"
21. locks={}; rpc="marker"; attempt=2
22. rpc="pointer"
23. rpc="validate"; chosen=1
24. rpc="open"
25. locks={<<1, "other">>}; rpc="finish"; loaded=<<0, 1>>
26. rpc="done"; returned=TRUE
```

## PublishPruneDangling

Violated `temporal`. [Bounds](PublishPruneDangling.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "version"); marker="none"; current=1; pc=<<11>>
2. loc=(0 :> "version" @@ 1 :> "none"); files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {}); manual=TRUE
3. ppc=<<"branch">>
4. locks={}
5. ppc=<<"cache">>
6. ppc=<<"idle">>
7. ppc=<<"branch">>
Back to state 5: <Next line 183, col 10 to line 185, col 52 of module Publish>
```

## PublishPruneOneShot

Violated `temporal`. [Bounds](PublishPruneOneShot.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "version"); marker="none"; current=1; pc=<<11>>
2. ppc=<<"branch">>; passes=<<1>>
3. ppc=<<"cache">>
4. ppc=<<"list">>; cached=<<1>>
5. ppc=<<"delete">>; pending=<<{<<0, "version">>}>>
6. files=(0 :> {"match", "other"} @@ 1 :> {"match", "other", "COMPLETE"})
7. files=(0 :> {"match"} @@ 1 :> {"match", "other", "COMPLETE"})
8. pending=<<{}>>; lockedPass=<<TRUE>>
9. locks={}
10. ppc=<<"idle">>
11. Stuttering
Then stutter forever (no further state changes).
```

## PublishPythonIncomplete

Violated `NoIncomplete`. [Bounds](PublishPythonIncomplete.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. ppc=<<"branch">>; passes=<<1>>
7. ppc=<<"cache">>
8. ppc=<<"list">>; cached=<<0>>
9. ppc=<<"delete">>; pending=<<{<<1, "tmp">>}>>
10. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"})
11. manifest=(0 :> {"match", "other"} @@ 1 :> {"match"}); pc=<<5>>
12. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "COMPLETE"}); pc=<<6>>
13. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
14. staged={1}; pc=<<8>>
15. current=1; staged={}; pc=<<9>>
16. rpc="pointer"
17. rpc="validate"; chosen=1
18. rpc="open"; badIncomplete=TRUE
```

## PublishRatingBinding

Violated `RatingBindsTarget`. [Bounds](PublishRatingBinding.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
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
13. rpc="target"
14. rpc="open"; target=1
15. locks={<<0, "match">>}; loaded=<<0>>
16. locks={<<0, "match">>, <<0, "other">>}; rpc="finish"; loaded=<<0, 0>>
17. rpc="done"; badBinding=TRUE; returned=TRUE
```

## PublishRatingIncomplete

Violated `NoIncomplete`. [Bounds](PublishRatingIncomplete.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. ppc=<<"branch">>; passes=<<1>>
7. ppc=<<"cache">>
8. ppc=<<"list">>; cached=<<0>>
9. ppc=<<"delete">>; pending=<<{<<1, "tmp">>}>>
10. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"})
11. manifest=(0 :> {"match", "other"} @@ 1 :> {"match"}); pc=<<5>>
12. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "COMPLETE"}); pc=<<6>>
13. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
14. staged={1}; pc=<<8>>
15. current=1; staged={}; pc=<<9>>
16. rpc="pointer"
17. rpc="validate"; chosen=1
18. rpc="target"; badIncomplete=TRUE
```

## PublishRatingResolveError

Violated `ReaderSucceeds`. [Bounds](PublishRatingResolveError.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. ppc=<<"branch">>; passes=<<1>>
11. ppc=<<"cache">>
12. ppc=<<"list">>; cached=<<0>>
13. current=1; staged={}; pc=<<9>>
14. ppc=<<"delete">>; pending=<<{<<1, "version">>}>>
15. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"other", "COMPLETE"})
16. rpc="pointer"
17. rpc="validate"; chosen=1
18. rpc="error"; readerError=TRUE
```

## PublishRatingRetryExhausted

Violated `ReaderSucceeds`. [Bounds](PublishRatingRetryExhausted.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none" @@ 2 :> "none"); marker="none"; current=0; pc=<<0, 0>>
2. loc=(0 :> "version" @@ 1 :> "tmp" @@ 2 :> "none"); pc=<<1, 0>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"} @@ 2 :> {}); pc=<<2, 0>>
4. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"} @@ 2 :> {} ); pc=<<3, 0>>
5. pc=<<4, 0>>
6. pc=<<5, 0>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {} ); pc=<<6, 0>>
8. loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "none"); pc=<<7, 0>>
9. staged={1}; pc=<<8, 0>>
10. loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "tmp"); pc=<<8, 1>>
11. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match"} ); pc=<<8, 2>>
12. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match", "other"} ); pc=<<8, 3>>
13. pc=<<8, 4>>
14. pc=<<8, 5>>
15. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} @@ 2 :> {"match", "other", "COMPLETE"} ); pc=<<8, 6>>
16. loc=(0 :> "version" @@ 1 :> "version" @@ 2 :> "version"); pc=<<8, 7>>
17. staged={1, 2}; pc=<<8, 8>>
18. rpc="pointer"
19. rpc="validate"; chosen=0
20. rpc="target"
21. rpc="open"; target=0
22. current=1; staged={2}; pc=<<9, 8>>
23. locks={<<0, "match">>}; loaded=<<0>>
24. locks={<<0, "match">>, <<0, "other">>}; rpc="finish"; loaded=<<0, 0>>
25. rpc="missing"
26. locks={}; rpc="marker"; loaded=<<>>; attempt=2
27. rpc="pointer"
28. rpc="validate"; chosen=1
29. rpc="target"
30. rpc="open"; target=1
31. current=2; staged={}; pc=<<9, 9>>
32. locks={<<1, "match">>}; loaded=<<1>>
33. locks={<<1, "match">>, <<1, "other">>}; rpc="finish"; loaded=<<1, 1>>
34. rpc="missing"
35. locks={}; rpc="error"; loaded=<<>>; readerError=TRUE
```

## PublishRetireRace

Violated `NoResurrection`. [Bounds](PublishRetireRace.cfg).

```text
1. Initial: loc=(0 :> "version" @@ 1 :> "none"); marker="none"; current=0; pc=<<0>>
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. current=1; staged={}; pc=<<9>>
11. marker="replaced"; external=TRUE; withdrawn={0, 1}; everWithdrawn=TRUE; retired=TRUE
12. marker="none"; pc=<<11>>
```

## PublishRetiredCrash

Violated `CrashAvailable`. [Bounds](PublishRetiredCrash.cfg).

```text
1. Initial: loc=(0 :> "version"); marker="replaced"; current=0; pc=<< >>
2. ppc=<<"branch">>; passes=<<1>>
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
2. loc=(0 :> "version" @@ 1 :> "tmp"); pc=<<1>>
3. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match"}); pc=<<2>>
4. files=(0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other"}); pc=<<3>>
5. pc=<<4>>
6. pc=<<5>>
7. files=( 0 :> {"match", "other", "COMPLETE"} @@ 1 :> {"match", "other", "COMPLETE"} ); pc=<<6>>
8. loc=(0 :> "version" @@ 1 :> "version"); pc=<<7>>
9. staged={1}; pc=<<8>>
10. current=1; staged={}; pc=<<9>>
11. marker="none"; pc=<<11>>
```
