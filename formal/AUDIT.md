# Publication and engine-callback audit

Audit target: production code at `683e691426319ef211f58d588a4f3974cc6523fc`.
Only `formal/` is changed. [RESULTS.md](RESULTS.md) records exact TLC counts;
[WITNESSES.md](WITNESSES.md) retains concrete state-by-state counterexamples.
Each `.cfg` is the executable statement of its bounds and checked properties.

## What was checked

`Publish.tla` separates table writes, schema validation, manifest enumeration,
COMPLETE creation, directory rename, staging CURRENT, atomic pointer replacement,
and removing RETIRED. Pruners independently choose their retirement branch, cache
the current version, list entries, delete individual files, remove the marker,
and remove the map directory. A reader checks RETIRED, samples CURRENT, validates,
then opens tables separately. Its handles can block deletes; closing a file does
not discard the already-read table. All actions interleave.

The largest publication configurations have **two extraction attempts, three
unique version identities including the old one, two table units plus COMPLETE,
one reader with two load attempts, and one pruner**. A separate configuration
has **two independent pruners and one writer**. Each pruner makes one pass in
safety configurations. Marker configurations separately exercise `stale: reason`,
`unreadable`, unknown text, empty legacy text, and `replaced`. Other configurations
allow one external retirement, one manual target deletion, and a process crash
after any transition. A crash terminates the actors; writer failure instead
leaves artifacts and permits a second attempt. `PublishRetry` serializes the
second attempt after the first succeeds or fails; `PublishTwoWriters` allows both
to run at once. Both include a reader and pruning.

The `match` unit includes `match.parquet` and the rating layout's required
`player_rounds.parquet`; `other` can be `damages.parquet`. This preserves the
important case where those two layout files survive but another intended table
is omitted. It does not enumerate every parquet column or every table name.
The deletion model allows arbitrary directory enumeration order and pauses
between child deletions. An actual `rmtree` may stop on its first error; the
partial-deletion witness uses an unlocked file before a locked file and was
also reproduced with the real Windows `rmtree`.

`Pipeline.tla` separately checks one stale map, one proposed replacement in
another archive, and a second unrelated unresolved queue row. It separates
publishing, `finish_job`'s validity check, saving `ok`, staging/replacing the
retirement marker, deleting old data, truncating the queue, writing retained
rows, and crashing. Invalidating the replacement is an environment action
justified by the publication counterexample or manual deletion. This is a
compositional check, not a claim that every combination of all configurations
was searched in one giant state space.

`MapGate.tla` checks **two maps and two hot reloads**, cold launch at the menu,
hot reload at the menu and in a match, menu ticks, delayed entity readiness,
worker replies, ordinary map teardown, and a direct map change without an old
OnMapEnd. `Plugin.tla` checks **two maps, three captures, two rounds per capture**,
probe construction/trace/warm-up failure, blocked and clear traces, match
restart/capture end, finalization, round end, mid-round initialization, and one
same-map hot reload in its targeted configuration. Existing `Capture.tla` covers
worker publication, scan identity/generations, reload accounting and interrupted
rounds; it is supplemented here rather than duplicated.

These are bounded checks, not an unbounded proof, a hardware/filesystem model,
or a proof of undocumented engine behavior. Process crashes preserve completed
filesystem operations. A power-loss proof would additionally need parquet and
directory-entry durability: atomic `os.replace` alone does not supply that.
Temporary-file creation and partial JSON writes before an atomic replace refine
to unpublished staging or failure; no reader consumes those staging files.
Unique nonces and distinct worker PIDs are assumed. A nonce collision that
makes Windows rename fail is a failed attempt, not reuse of an existing folder.

## Invariants and liveness results

“Holds within bounds” below means the configurations named in that row were
exhaustively searched; the exact counts are in RESULTS.md. A counterexample
only needs its much smaller prefix, retained in WITNESSES.md.

| Requirement / model predicate | Result and bounds | Code and suggested fix |
| --- | --- | --- |
| Whole-attempt readers never combine versions (`NoMix`) | **Holds within the bounds above**, including two simultaneous writers, retry after failure, and two pruners in their respective configurations: `PublishPython`, `Node`, `Rating`, `TwoWriters`, `Retry`, `TwoPruners`. | [extract.py:1514](../extractor/extract.py#L1514), [demo_paths.py:129](../model/rating3/demo_paths.py#L129). Immutable unique directories plus discarding an entire failed attempt are essential. |
| Every allowed interpretation of the documented Node retry is unmixed | **Counterexample `PublishNodePerFile`**: read old match; publish new; prune old remaining table; resolve again; retain old match and read new other. | [SCHEMA-v1.md:14](../extractor/SCHEMA-v1.md#L14). Require discarding **all** tables and metadata from the failed attempt. This is a design counterexample, not a claim about an absent Node implementation. |
| A resolved version contains all intended tables (`NoIncomplete`) | **Counterexamples `PublishPythonIncomplete`, `NodeIncomplete`, `RatingIncomplete`**, one writer/pruner/reader. Validation passes, pruning removes an intended table, then manifest enumeration omits it and publication succeeds. | [extract.py:1968](../extractor/extract.py#L1968), [1539](../extractor/extract.py#L1539), [1598](../extractor/extract.py#L1598); resolver [1522](../extractor/extract.py#L1522). Protect active staging directories; construct and verify the expected catalog before publication. Validate required schema tables, not just the files that happen to remain. |
| CURRENT points to a valid complete version (`CurrentValid`) | **Counterexample `PublishCurrentRace`**, one writer and one pruner. | [extract.py:1590](../extractor/extract.py#L1590), [1594](../extractor/extract.py#L1594), [1533](../extractor/extract.py#L1533). Serialize publication and pruning under a per-map cross-process lock, including deciding what may be deleted. Re-reading CURRENT without mutual exclusion still leaves a check/delete race. |
| Stale/unreadable/unknown-marked data is not deleted before replacement (`StaleKept`) | **Holds within one writer, one pruner, all failure/crash positions**, separately for stale, unreadable and unknown marker text (`PublishStale`, `Unreadable`, `Unknown`). | [extract.py:1577](../extractor/extract.py#L1577), [1613](../extractor/extract.py#L1613). Keep the fail-closed marker handling. Empty/replaced marker configurations also pass the predicate, but trust their marker as authority that replacement occurred. |
| A stale map is deleted only while a real replacement exists (`ReplacementBeforeDelete`) | **Holds within `PipelineSafety`'s bounds** if identity and replacement availability are assumed. **Counterexamples `PipelineLostReplacement`, `PipelineIdentity`** remove those assumptions. | [demo_pipeline.py:633](../extractor/demo_pipeline.py#L633), [365](../extractor/demo_pipeline.py#L365), [377](../extractor/demo_pipeline.py#L377). Revalidate and retain/pin the exact successor at retirement; record source identity and successor generation. Filename plus byte count is not content identity. |
| A withdrawn version never becomes freshly resolvable (`NoResurrection`) | **Counterexample `PublishRetireRace`**: publish V1; external retire writes RETIRED and pauses; writer removes RETIRED; V1 resolves; retire's subsequent prune sees a live map and preserves it. | [extract.py:1631](../extractor/extract.py#L1631), [1977](../extractor/extract.py#L1977). Use a withdrawal generation/token and a map lock. A writer may clear only the withdrawal generation it explicitly replaces. |
| A withdrawn map path never becomes resolvable at all (`StrictWithdrawal`) | **Counterexample `PublishStrictWithdrawal`**, no concurrency needed: stale V0 is intentionally replaced in place by V1. | [extract.py:1954](../extractor/extract.py#L1954), [1977](../extractor/extract.py#L1977). This literal invariant conflicts with the implementation's intended recovery. Specify version/generation revocation, or forbid path reuse and publish successors elsewhere. |
| After a process crash an established map resolves or is explicitly withdrawn (`CrashAvailable`) | **Holds within `PublishCrashSerial`**, one writer and no concurrent prune. **Counterexample `PublishCrash`** adds one pruner. | Same cached-pointer race above; [demo_pipeline.py:398](../extractor/demo_pipeline.py#L398) logs a dangling CURRENT but does not repair it. Lock publishers/pruners and specify recovery to a valid predecessor or an explicit unavailable marker. |
| The same crash guarantee covers initial creation and retirement cleanup | **Counterexamples `PublishFreshCrash`, `PublishRetiredCrash`**. Crash after initial mkdir leaves an unpublished map; crash after unlinking RETIRED and before rmdir leaves an empty untombstoned map directory. | [extract.py:1960](../extractor/extract.py#L1960), [1584](../extractor/extract.py#L1584). Either exclude never-published/fully-deleted maps from the guarantee explicitly, or retain durable publication/withdrawal metadata outside deletable map contents. |
| Hand-deleting CURRENT's target cannot leave an unclassified map | **Counterexample `PublishManual`**: delete the target, then crash. No reader accepts it, but CURRENT is dangling and no withdrawal marker exists. | [extract.py:1515](../extractor/extract.py#L1515), [1593](../extractor/extract.py#L1593). A reader correctly refuses it; availability needs a repair/tombstone policy. Protect target folders or make manual deletion an explicitly unsupported operation. |
| Old versions eventually prune once unlocked (`OldEventuallyPruned`) | **Holds within `PublishPruneLive`**, one obsolete version, one healthy current version, file locks eventually released, and infinitely recurring fair prunes. **Counterexamples `PublishPruneOneShot`, `PublishPruneDangling`**: no later prune, or every later prune refuses the dangling CURRENT. | [extract.py:1560](../extractor/extract.py#L1560), [1593](../extractor/extract.py#L1593), [demo_pipeline.py:403](../extractor/demo_pipeline.py#L403). Add recurring cleanup and recovery of invalid pointers; unlocking alone does not schedule work. |
| Rating's one retry always succeeds (`ReaderSucceeds`) | **Counterexample `PublishRatingRetryExhausted`**, two complete publishes, no pruning needed. `PublishRatingResolveError` also shows incomplete resolution can fail before the FileNotFoundError retry. These are availability failures, not mixed successful results. | [demo_paths.py:127](../model/rating3/demo_paths.py#L127), [133](../model/rating3/demo_paths.py#L133), [138](../model/rating3/demo_paths.py#L138). Use bounded backoff for transient incomplete versions if desired; guaranteed completion needs writer quiescence or a reader lease. |
| Rating's sampled pointer actually identifies the chosen layout (`RatingBindsTarget`) | **Counterexample `PublishRatingBinding`**: resolve V0; publish V1 before `_current_target`; both pointer samples are V1 while loading and returning V0. | [demo_paths.py:129](../model/rating3/demo_paths.py#L129), [130](../model/rating3/demo_paths.py#L130), [136](../model/rating3/demo_paths.py#L136). Bind the sampled target to `layout.directory`, or return the target from the resolver. This weakens freshness detection; it does not by itself mix tables. |
| Crashing a needs_reextract rewrite preserves unrelated unresolved rows (`CrashQueuePreserved`) | **Counterexample `PipelineQueueCrash`**: open/truncate the JSONL, crash before retained rows are written. | [demo_pipeline.py:383](../extractor/demo_pipeline.py#L383). Write/fsync a staged file, then atomically replace; make restart recovery idempotent. |
| Refeeding a completed archive eventually schedules re-extraction (`RefeedEventuallyProcessed`) | **Conditional counterexample `PipelineRefeed`**: a refeed that keeps the same done ledger ID is skipped forever. | [demo_pipeline.py:465](../extractor/demo_pipeline.py#L465). Provide a re-extraction override keyed to needs_reextract, or explicitly clear/version the ledger ID in the feeder protocol. The external refeed implementation is absent here. |
| No menu entity access, gate implies loaded map, initialized implies loaded map (`NoMenuEntities`, `GateSound`, `InitializedSound`) | **Holds within two maps/two reloads**, separately for cold, hot-menu and hot-match configurations, under the engine assumptions below. Menu OnTick is enabled. | [Lifecycle.cs:54](../plugin/Core/Lifecycle.cs#L54), [BotMatchStatsPlugin.cs:171](../plugin/Game/BotMatchStatsPlugin.cs#L171), [216](../plugin/Game/BotMatchStatsPlugin.cs#L216), [663](../plugin/Game/BotMatchStatsPlugin.cs#L663). Keep map-name polling and EntityListReady behind the gate; OnTick alone is not evidence of a map. |
| The gate opens and initialization completes once a map remains live (`EventuallyOpen`, `EventuallyInit`) | **Holds within those same MapGate bounds**, with fair housekeeping/readiness/start callbacks, finite reloads, and completed teardown. No claim for a transient map that ends before a timer can run. | [BotMatchStatsPlugin.cs:216](../plugin/Game/BotMatchStatsPlugin.cs#L216), [217](../plugin/Game/BotMatchStatsPlugin.cs#L217), [365](../plugin/Game/BotMatchStatsPlugin.cs#L365). These are conditional liveness guarantees. |
| Menu safety survives omitted/late map end, stale map names, or a reload during teardown | **Assumption counterexamples `MapGateLateEnd`, `StaleName`, `ReloadDuringEnd`**. In the last case the old instance received OnMapEnd, the new instance polls a still-named server, then that server disappears without another OnMapEnd. | [BotMatchStatsPlugin.cs:216](../plugin/Game/BotMatchStatsPlugin.cs#L216), [680](../plugin/Game/BotMatchStatsPlugin.cs#L680). Establish engine ordering/epoch guarantees, or gate every entity entry point using an authoritative live generation. |
| Menu safety survives an exception during map-end finalization | **Counterexample `MapGateEndThrows`**: EndMatch/Abandon throws before `_needInit` and scan state reset; server tears down; housekeeping accesses entities. | [BotMatchStatsPlugin.cs:683](../plugin/Game/BotMatchStatsPlugin.cs#L683), [685](../plugin/Game/BotMatchStatsPlugin.cs#L685), [226](../plugin/Game/BotMatchStatsPlugin.cs#L226), [606](../plugin/Game/BotMatchStatsPlugin.cs#L606). Reset gating/scan state first or in a finally block; guard steady-state housekeeping and TickBody with map state as defense in depth. |
| No menu traces, no visible enemy after LOS failure, failure sticks for a tracker lifetime (`NoMenuTrace`, `NoVisibleWhenOff`, `FailureSticky`) | **Holds within `PluginSafety`**, two maps/three captures/two rounds, no same-map reattachment. Failures stop traces and close visible state. | [Los.cs:63](../plugin/Core/Los.cs#L63), [Recorder.cs:258](../plugin/Core/Recorder.cs#L258), [701](../plugin/Core/Recorder.cs#L701). Preserve centralized failure handling. MapGate assumptions also protect the game-layer SetIgnore and warm-up paths. |
| A LOS failure stays disabled for the entire engine map, across hot reload | **Counterexample `PluginHotReload`**: failure on map 1; reload on map 1; OnMapReady attaches a new successful probe and clears Failure. | [Warm.cs:61](../plugin/Game/Warm.cs#L61), [79](../plugin/Game/Warm.cs#L79), [Los.cs:69](../plugin/Core/Los.cs#L69). Persist disabled status by map generation if “rest of map” includes reload, or document that reload deliberately retries LOS. |
| A live capture records its failed LOS source (`FailureRecorded`, `LiveSourceRecorded`) | **Holds for ordinary freeze-end starts within `PluginSafety`**. **Counterexamples `PluginMidRoundError`, `PluginMidRoundSource`**: probe failure before capture; StartCapture creates fresh metadata; BeginRoundMidway marks Live without FreezeEnd's source/error updates. | [Warm.cs:91](../plugin/Game/Warm.cs#L91), [Recorder.cs:263](../plugin/Core/Recorder.cs#L263), [135](../plugin/Core/Recorder.cs#L135), [214](../plugin/Core/Recorder.cs#L214), [242](../plugin/Core/Recorder.cs#L242), [BotMatchStatsPlugin.cs:584](../plugin/Game/BotMatchStatsPlugin.cs#L584). Initialize visibility metadata from the current LOS state on StartCapture/Resume and every mid-round activation. |
| Live implies active capture, rounds are sealed at most once (`CaptureSound`, `NoDoubleSeal`) | **Holds within `PluginSafety`**, supplementing Capture.tla's writer/scan checks. | [Recorder.cs:810](../plugin/Core/Recorder.cs#L810), [894](../plugin/Core/Recorder.cs#L894). Keep idempotent finalize/end guards. |
| A finalized round cannot become live again (`NoPostFinalizeLive`) | **Holds under ordered callbacks within `PluginSafety`**. **Assumption counterexample `PluginLateFreeze`**: finalize then late/duplicate FreezeEnd sets Live=true while RoundFinalized remains true. | [Recorder.cs:238](../plugin/Core/Recorder.cs#L238), [Events.cs:93](../plugin/Game/Events.cs#L93). Reject freeze-end for finalized rounds or tag events with the active round generation. |
| A finished match cannot start another capture (`NoCaptureAfterWin`) | **Conditional counterexample `PluginAfterWin`**: win panel; EndCapture; another non-warmup round_start on the same finished game starts capture. | [Events.cs:36](../plugin/Game/Events.cs#L36), [81](../plugin/Game/Events.cs#L81). Guard against remembered win/game-ended state, clearing it only for a confirmed new game. Existing Capture.tla's RoundStart already assumes `~winSeen`; that guard is stronger than the real handler, so its proof does not establish this property of the code. |

## Concrete source-level schedules

The machine-readable details are rendered in WITNESSES.md. The most consequential
short schedules are:

1. **Cached-current deletion.** Pruner evaluates `current = resolve_map_dir(...)`
   at extract.py:1590 and gets V0. Writer publishes V1 with `_write_pointer` at
   :1547/:1533. Pruner lists at :1594, then :1595 protects only V0; :1598 deletes
   V1. CURRENT still names V1. A crash preserves that dangling pointer. The
   deterministic replay also lets the writer's own prune remove V0 first, so
   the old pointer cannot be used as a fallback either.
2. **Retirement resurrection.** Writer replaces CURRENT at :1533. Retirer writes
   `replaced` at :1631 and pauses before :1632. Writer unlinks RETIRED at :1977.
   Resolution at :1507/:1515 now returns the withdrawn V1. Retirer's :1632 prune
   sees no RETIRED and preserves CURRENT, so the resurrection can persist.
3. **Manifest omission.** All output tables have passed :1969. Startup prune
   enters :1598 for `.tmp-<pid>`; Windows rmtree deletes `damages.parquet` before
   encountering locked `match.parquet`. The lock is released. Writer enumerates
   only surviving tables at :1539, writes COMPLETE, renames and publishes. Both
   the extractor and rating resolver accept the surviving catalog. This is
   incomplete relative to the intended schema, not a mix of table versions.
4. **Replacement not retained.** `finish_job` validates the new map at
   demo_pipeline.py:633 and stores ok. A prune or manual operation removes its
   target. `replace_old_extractions` trusts cached ok at :365 and retires the
   stale old map at :377 without re-resolving or pinning the successor.
5. **LOS metadata on mid-round entry.** AttachLos fails at Warm.cs:91 while not
   Capturing, so Recorder.cs:263 skips metadata updates. StartMidMatchIfLive
   creates fresh Env at BotMatchStatsPlugin.cs:532 and calls BeginRoundMidway
   at :584. Recorder.cs:214 activates the round without FreezeEnd at :242.
   LOS remains off, LosDue never invokes CheckLos, and the file can omit both
   the failure reason and mask source until some later freeze-end.

`python -I formal/reproduce.py` replays schedules 1–3 and both rating-helper
findings through the **verbatim source functions**, with real Windows file
operations and thread barriers. It also imports the real rating helper.
Only dataframe/parquet encoding and schema parsing are stubbed; fake table
contents are sufficient because the failures concern directory/marker/pointer
ordering. All five replays passed. The script writes only beneath ignored
`formal/states/reproduce/` and never patches production source.

## Pipeline reachability and reader inventory

Within a single uninterrupted pipeline, startup tidy precedes dispatch
([demo_pipeline.py:945](../extractor/demo_pipeline.py#L945)); its own startup
pruner cannot race its own newly dispatched workers. But every writer prunes
after publishing, workers are concurrent, and a same-output collision is
possible: [slug_for:185](../extractor/demo_pipeline.py#L185) truncates archive IDs
to eight characters. Two distinct archives with the same team prefix and first
eight ID characters can target the same map path. Retried failed archives reuse
the slug (:184), and failures in one map can cause another successful map in
that archive to be extracted again. A standalone extractor or an orphan worker
after a failed job-object attachment (:940) can also overlap startup tidy.
The model deliberately permits those overlaps; it does not assume the HTTP
port binding is a per-map filesystem lock. `_dup` map-key generation inside one
archive (:562) prevents that narrower source of simultaneous same-path jobs.

The needs_reextract path matches successful result `(dem_file, dem_bytes)` at
:365, excludes directories in `new_dirs` at :375, and retires old paths at :377.
Thus a successful in-place re-extraction uses write_output's unretire path;
a different-archive successor uses retire_map. Failed results leave stale data
and its row alone. File locks leave the replacement marker and remaining data
for a later startup. Queue truncation and completed-ledger refeed are modeled
separately because their safety is not implied by correct version publishing.

Tracked readers were inspected with repository-wide searches for CURRENT,
COMPLETE, RETIRED, parquet reads, and shared helper calls:

- `extract.resolve_map_dir` validates a fixed chosen directory. It returns a
  path or None; it does not itself load tables or implement a transactional
  retry. The Python reader model includes a client following its retry advice
  while discarding the entire failed attempt.
- `model/rating3/demo_paths.py` validates the manifest and layout, and
  `load_demo_tables` discards failed batches and retries once. `eco_fit.py:63`
  and `swing_fit.py:43` use it. `join_demos.py:78`,
  `demo_round_fit.py:265/:322`, and `postplant_analysis.py:22` pin a layout and
  read files directly; they can fail on deletion and do not inherit the helper's
  retry guarantee, but do not independently choose a new version per table.
- There is **no tracked Node parquet reader implementing SCHEMA-v1.md** at
  this revision. The app's `app/src/ui/data/engine.ts` is a stats-view adapter,
  not a CURRENT/COMPLETE reader. `PublishNode` checks the documented contract
  with whole-attempt retry; `PublishNodePerFile` demonstrates the ambiguity if
  retrying a missing file retains already-read tables. No claim is made about
  an implementation that is not present.
- There is **no tracked refeed/downloader implementation**. `PipelineRefeed`
  checks the observable pipeline behavior if the feeder submits the same done
  archive identity. A feeder that clears the ledger or changes identity is a
  different assumption and may avoid that trace.

Legacy flat folders are accepted without COMPLETE at extract.py:1516. Pruning
orders their match.parquet first (:1594), preserving refusal of subsequently
started legacy resolves; pre-v1 meta.parquet-only folders are not treated as
schema-v1 maps. The versioned models do not certify the completeness of legacy
tables: the legacy design has no completion manifest and cannot provide that
stronger guarantee under corruption/manual changes. Staged-file disappearance,
failed rename, and invalid CURRENT cause refusal/error rather than permission
to load another folder's table. Malicious manifest contents, symlinks, parquet
parser defects, nonce/PID reuse and power-loss reordering are outside the bounds.

## Engine assumptions versus proven behavior

The passing MapGate checks assume all of the following; TLC does **not** prove
these facts about CS2 or CounterStrikeSharp:

1. Callbacks, housekeeping, scan delivery and reload initialization are serialized
   on the game thread. No server teardown interleaves within a callback.
2. OnMapStart denotes a live game server and precedes callbacks using its
   entities. MapEnd completes before the old server's entity state becomes
   unavailable. A direct map change delivers the new OnMapStart before a tick
   using the new map. A cold-loaded plugin is not silently injected into an
   already-running map with `hotReload=false` and no OnMapStart.
3. A map name is nonempty exactly when a game server exists; reading MapName
   is safe at the menu. EntityListReady's raw-pointer query is safe once that
   server exists and does not falsely certify a destroyed entity system.
   The native implementation claims in the C# comment were not independently
   established by these local models.
4. No reload starts in the interval after the old instance's OnMapEnd and before
   actual server teardown. `MapGateReloadDuringEnd` shows why this extra epoch
   assumption matters even with an accurate current MapName.
5. Map-end cleanup does not throw before resetting `_needInit`/scan state.
   `MapGateEndThrows` deliberately removes this assumption.
6. For liveness, housekeeping continues, a live map eventually has usable
   entities/game rules, TryInit is not permanently disabled by Mem.Init, start
   callbacks eventually arrive, teardown completes, and reloads eventually stop.
   Mere OnTick delivery is insufficient and is never used to open the gate.

For recorder/LOS safety, ordinary round callbacks are ordered and do not deliver
a late freeze-end for an already-finalized round. If a new round_start may arrive
after match completion without a confirmed restart, the code needs its own
finished-game guard; the old Capture model's guard cannot establish this for it.
WarmStep and the engine-bound warm-up paths run only after initialization and
outside live rounds (BotMatchStatsPlugin.cs:239, Warm.cs:108); OnMapReady resets
their per-map progress. Their entity safety therefore rests on the same gate
and callback assumptions. The core background warm-up does not depend on engine
map callbacks. Existing Calls.tla models the separate BotBuy purchase/refund
protocol; this audit does not reinterpret that as an engine teardown proof.

One additional source observation: OnMapStart without OnMapEnd nulls `_rules`
at BotMatchStatsPlugin.cs:675 but does not invalidate `_scanPending`/`_scanGen`.
An already-queued resume can consequently reach :545/:547 with null rules before
Housekeeping's initialization guard (:209 versus :211). The outer catch drops
that response without unsafe entity access, and later initialization rescans.
The MapGate model abstracts this as a consumed old reply; it does not claim the
callback is exception-free. Reset pending scan state and advance the generation
at every map boundary to make this path explicit and robust.

## Design verdict and recommended protocol

SCHEMA-v1.md's immutable unique version directories, COMPLETE-last, and atomic
CURRENT replacement are sufficient for **single-generation reads on successful
whole-attempt loads**, assuming completed table writes and no malicious
filesystem modification. They are **insufficient for all requested guarantees**.
The documented claim that old directories are deleted only once no reader holds
files open is stronger than `shutil.rmtree`: unlocked children can disappear
before a locked child stops deletion. Resolving is validation, not a lease.

The design needs these additional rules:

- A cross-process per-map transaction/lock covering writer staging registration,
  publish, withdrawal, and the pruner's decision plus deletion. Active writers'
  temporary paths must not be garbage. Every attempted publication has an
  immutable, validated expected table catalog.
- Withdrawal and publication generations, with a tombstone that an old writer
  cannot clear. Specify whether revocation forbids **new** reads only or also
  invalidates already-resolved/open readers. Existing handles cannot be revoked
  simply by creating RETIRED.
- A reader contract that pins one generation, discards the entire failed batch,
  and either obtains a lease for the entire read or tolerates/retries missing
  files. Bounded retries provide bounded effort, not unconditional liveness.
  Sizes alone do not detect same-size corruption; hashes are needed if content
  integrity beyond incomplete writes is a requirement.
- A durable successor reference when stale data is retired, plus source content
  identity. Do not delete the last trustworthy copy because a cached result bit
  or an empty legacy marker says a replacement once existed.
- Atomic queue rewrites, explicit refeed/ledger semantics, recurring cleanup,
  and a documented policy for dangling pointers, never-published paths and
  hand-deleted targets. A total availability guarantee cannot survive arbitrary
  deletion of the only version without replication/recovery data.

These are protocol changes for the extractor/plugin/model owners. None were
silently applied to production code as part of the formal-model work.
