------------------------------- MODULE Archive -------------------------------
(***************************************************************************)
(* The demo pipeline's archive lifecycle (extractor/demo_pipeline.py):      *)
(* scan, hashing, pending, extracting, parsing, then finish_archives with   *)
(* stitching or holding split maps, the unaccounted check, removing the     *)
(* work folder and the RAR, and the ledger row; or fail_archive, which      *)
(* keeps the RAR in failed/ for --retry-failed or drops a truncated one;    *)
(* enforce_parts_cap, which deletes the held parts of archives no longer in *)
(* flight; and enforce_failed_cap, which evicts the oldest kept failures.   *)
(* The pipeline is one process (its HTTP port admits one instance) whose    *)
(* main loop runs these steps one at a time; it can crash between any two,  *)
(* losing its in-memory state (self.archives, self.retried), and a restart  *)
(* deletes leftover work folders and scans again. The user may download a   *)
(* deleted archive again.                                                   *)
(*                                                                         *)
(* Abstractions: each archive holds one whole map and one map recorded as   *)
(* two parts; a worker's outcome is one value per archive (every demo ok,   *)
(* some failing, or all truncated); an ok whole map is published by its     *)
(* worker before the archive finishes, and "published" is one boolean, so   *)
(* versions and double publication are Publish.tla's and Pipeline.tla's,    *)
(* not checked here. The ledger is keyed by archive, though the code keys a *)
(* retried failure by its failed/ folder name; due_for_retry is assumed     *)
(* true. The three fixes are switches, TRUE in the shipped code; FALSE is   *)
(* the code before them (main b5868a2).                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Archives,         \* e.g. {1, 2}
  Crashes,          \* pipeline crashes allowed in a behaviour
  Redownloads,      \* times the user may download a deleted archive again
  RetryFailed,      \* the run uses --retry-failed
  CapPressure,      \* parts/ can pass MAX_PARTS_GB, so enforce_parts_cap deletes held parts
  FailedPressure,   \* failed/ can pass MAX_FAILED_GB, so enforce_failed_cap evicts kept failures
  WorkerFails,      \* a parse can fail or be truncated, and a stitch can leave no complete map
  CheckFirst,       \* finish_archives runs unaccounted() before deleting anything (shipped); FALSE skips it
  LedgerFirst,      \* shipped: the done row before the RAR goes, and a start deletes a done archive's RAR
  ExpiryRowFirst,   \* shipped: enforce_parts_cap writes the expired row before deleting the parts
  EvictionFixed     \* shipped: enforce_failed_cap leaves kept failures in flight alone, and writes a ledger row
                    \* before deleting, so a later download of the archive is not skipped as failed

VARIABLES
  phase,      \* phase[a]: where the main loop has it; "idle" when not in self.archives
  rar,        \* rar[a] \in {"downloads", "failed", "gone"}
  ledger,     \* ledger[a] \in {"none", "done", "failed", "evicted"}: the archive's last ledger row
  dropped,    \* dropped[a]: failed_dropped.jsonl records the archive as deleted with its maps unaccounted
  evicted,    \* ghost: enforce_failed_cap deleted the archive's kept failure
  outcome,    \* outcome[a] \in {"none", "ok", "bad", "truncated"}: this attempt's worker results
  whole,      \* whole[a]: the whole map is published (resolves)
  split,      \* split[a] \in {"none", "stitched", "broken", "held", "expired"}: the split map, per parts.jsonl;
              \* "broken" is a stitch that reported success but left no complete map
  parts,      \* parts[a]: the split map's part folders hold their tables
  rows,       \* rows[a]: parts.jsonl statuses written for the archive
  work,       \* work[a]: the archive's extracted demos are on disk
  retried,    \* self.retried: failed/ archives tried, or freshly failed, in this run
  capPending, \* in memory: archives enforce_parts_cap is between its two steps on
  evictPending, \* in memory: kept failures enforce_failed_cap has recorded and not yet deleted
  unrecorded, \* on disk: archives whose held parts are deleted with no expired row
  capActive,  \* ghost: the cap deleted parts of an archive in flight
  crashes,
  downloads   \* re-downloads so far

vars == <<phase, rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
          capPending, evictPending, unrecorded, capActive, crashes, downloads>>

Phases == {"idle", "hashing", "pending", "extracting", "parsing", "stitch", "check", "work", "rar", "ledger",
           "fhold", "fmove", "fwrite", "fdrop", "fdelete", "fledger", "fcap"}

Init ==
  /\ phase = [a \in Archives |-> "idle"]
  /\ rar = [a \in Archives |-> "downloads"]
  /\ ledger = [a \in Archives |-> "none"]
  /\ dropped = [a \in Archives |-> FALSE]
  /\ evicted = [a \in Archives |-> FALSE]
  /\ outcome = [a \in Archives |-> "none"]
  /\ whole = [a \in Archives |-> FALSE]
  /\ split = [a \in Archives |-> "none"]
  /\ parts = [a \in Archives |-> FALSE]
  /\ rows = [a \in Archives |-> {}]
  /\ work = [a \in Archives |-> FALSE]
  /\ retried = {}
  /\ capPending = {}
  /\ evictPending = {}
  /\ unrecorded = {}
  /\ capActive = FALSE
  /\ crashes = 0
  /\ downloads = 0

Active == {a \in Archives : phase[a] # "idle"}
\* enforce_parts_cap or enforce_failed_cap is between its two steps
Busy == capPending # {} \/ evictPending # {}
\* phases inside one finish_archives or fail_archive call, which runs to its end before the loop touches another
\* archive; the waiting phases (hashing, pending, extracting, parsing) interleave across archives
InCall == {"check", "work", "rar", "ledger", "fhold", "fmove", "fwrite", "fdrop", "fdelete", "fledger", "fcap"}
Alone(a) == \A b \in Archives : b # a => phase[b] \notin InCall
Set(f, a, v) == [f EXCEPT ![a] = v]

\* scan(): a downloads RAR whose last ledger row is not done or failed, or (with --retry-failed) a failed/ RAR not
\* tried or freshly failed in this run, whatever its ledger says: a crash can leave one there before its row
Scan(a) ==
  /\ ~Busy /\ Alone(a)
  /\ phase[a] = "idle"
  /\ \/ rar[a] = "downloads" /\ ledger[a] \notin {"done", "failed"}
     \/ RetryFailed /\ rar[a] = "failed" /\ ledger[a] \in {"none", "failed"} /\ a \notin retried
  /\ phase' = Set(phase, a, "hashing")
  /\ retried' = IF rar[a] = "failed" THEN retried \cup {a} ELSE retried
  /\ outcome' = Set(outcome, a, "none")
  /\ UNCHANGED <<rar, ledger, dropped, evicted, whole, split, parts, rows, work, capPending, evictPending,
                 unrecorded, capActive, crashes, downloads>>

Hash(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "hashing" /\ phase' = Set(phase, a, "pending")
           /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                          capPending, evictPending, unrecorded, capActive, crashes, downloads>>
Extract(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "pending" /\ phase' = Set(phase, a, "extracting") /\ work' = Set(work, a, TRUE)
              /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, retried,
                             capPending, evictPending, unrecorded, capActive, crashes, downloads>>

\* the workers parse every demo: an ok whole map is published and an ok part is written to parts/
Parse(a) ==
  /\ ~Busy /\ Alone(a)
  /\ phase[a] = "extracting"
  /\ \E o \in (IF WorkerFails THEN {"ok", "bad", "truncated"} ELSE {"ok"}) :
       /\ outcome' = Set(outcome, a, o)
       /\ whole' = IF o = "ok" THEN Set(whole, a, TRUE) ELSE whole
       /\ parts' = IF o = "ok" THEN Set(parts, a, TRUE) ELSE parts
  /\ phase' = Set(phase, a, "parsing")
  /\ UNCHANGED <<rar, ledger, dropped, evicted, split, rows, work, retried, capPending, evictPending,
                 unrecorded, capActive, crashes, downloads>>

\* ---------------------------------------------------------------- fail_archive, step by step (1404-1458)

\* stitch_parts(failed): the split map is held with the failure as its reason
FailHold(a) ==
  /\ ~Busy /\ Alone(a)
  /\ phase[a] = "fhold"
  /\ rows' = Set(rows, a, rows[a] \cup {"held"}) /\ split' = Set(split, a, "held")
  /\ phase' = Set(phase, a, IF outcome[a] = "truncated" THEN "fdrop" ELSE "fmove")
  /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, parts, work, retried, capPending, evictPending,
                 unrecorded, capActive, crashes, downloads>>
\* every failing demo truncated: the failed_dropped row, then the RAR goes
FailDrop(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fdrop" /\ dropped' = Set(dropped, a, TRUE) /\ phase' = Set(phase, a, "fdelete")
               /\ UNCHANGED <<rar, ledger, evicted, outcome, whole, split, parts, rows, work, retried, capPending,
                              evictPending, unrecorded, capActive, crashes, downloads>>
FailDelete(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fdelete" /\ rar' = Set(rar, a, "gone") /\ work' = Set(work, a, FALSE)
                 /\ phase' = Set(phase, a, "fledger")
                 /\ UNCHANGED <<ledger, dropped, evicted, outcome, whole, split, parts, rows, retried, capPending,
                                evictPending, unrecorded, capActive, crashes, downloads>>
\* otherwise the RAR moves into failed/<slug>/ (a retried one is there already)
FailMove(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fmove" /\ rar' = Set(rar, a, "failed") /\ phase' = Set(phase, a, "fwrite")
               /\ UNCHANGED <<ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried, capPending,
                              evictPending, unrecorded, capActive, crashes, downloads>>
\* the failing demos and reports are written beside it and work/ goes; a fresh failure is not retried in this run
FailWrite(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fwrite" /\ work' = Set(work, a, FALSE) /\ retried' = retried \cup {a}
                /\ phase' = Set(phase, a, "fledger")
                /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, capPending,
                               evictPending, unrecorded, capActive, crashes, downloads>>
\* _record_failure: the failed row; the archive leaves self.archives, then enforce_failed_cap runs
FailLedger(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fledger" /\ ledger' = Set(ledger, a, "failed")
                 /\ phase' = Set(phase, a, IF outcome[a] = "truncated" THEN "idle" ELSE "fcap")
                 /\ UNCHANGED <<rar, dropped, evicted, outcome, whole, split, parts, rows, work, retried, capPending,
                                evictPending, unrecorded, capActive, crashes, downloads>>
FailDone(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "fcap" /\ evictPending = {} /\ phase' = Set(phase, a, "idle")
               /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                              capPending, evictPending, unrecorded, capActive, crashes, downloads>>

\* enforce_failed_cap (1492-1510), inside a failing archive's last step: for a kept failure (in the code, in
\* flight or not; with EvictionFixed, only one not in flight or the failing archive itself, which has already
\* left self.archives), the failed_dropped row (with EvictionFixed, a ledger row too), then the folder goes
EvictRecord(x) ==
  /\ ~Busy
  /\ FailedPressure /\ \E a \in Archives : phase[a] = "fcap"
  /\ rar[x] = "failed" /\ x \notin evictPending
  /\ EvictionFixed => (x \notin Active \/ phase[x] = "fcap")
  /\ dropped' = Set(dropped, x, TRUE)
  /\ ledger' = IF EvictionFixed THEN Set(ledger, x, "evicted") ELSE ledger
  /\ evictPending' = evictPending \cup {x}
  /\ UNCHANGED <<phase, rar, evicted, outcome, whole, split, parts, rows, work, retried, capPending,
                 unrecorded, capActive, crashes, downloads>>
EvictDelete(x) ==
  /\ x \in evictPending
  /\ rar' = Set(rar, x, "gone") /\ evicted' = Set(evicted, x, TRUE)
  /\ evictPending' = evictPending \ {x}
  /\ UNCHANGED <<phase, ledger, dropped, outcome, whole, split, parts, rows, work, retried, capPending,
                 unrecorded, capActive, crashes, downloads>>

\* ---------------------------------------------------------------- finish_archives, step by step (1289-1323)

\* parsed with a failing demo: fail_archive
ToFail(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "parsing" /\ outcome[a] \in {"bad", "truncated"} /\ phase' = Set(phase, a, "fhold")
             /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                            capPending, evictPending, unrecorded, capActive, crashes, downloads>>
\* stitch_parts: the split map is stitched into demos/ (its parts deleted) or held with its parts
Stitch(a) ==
  /\ ~Busy /\ Alone(a)
  /\ phase[a] = "parsing" /\ outcome[a] = "ok"
  /\ \E s \in (IF WorkerFails THEN {"stitched", "broken", "held"} ELSE {"stitched", "held"}) :
       /\ split' = Set(split, a, s)
       /\ rows' = Set(rows, a, rows[a] \cup {IF s = "broken" THEN "stitched" ELSE s})
       /\ parts' = IF s = "held" THEN parts ELSE Set(parts, a, FALSE)
  /\ phase' = Set(phase, a, "check")
  /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, work, retried, capPending, evictPending,
                 unrecorded, capActive, crashes, downloads>>
\* unaccounted(): otherwise the archive fails (fail_archive) and its RAR stays
Check(a) ==
  /\ ~Busy /\ Alone(a)
  /\ phase[a] = "check"
  /\ IF ~CheckFirst \/ (whole[a] /\ (split[a] = "stitched" \/ (split[a] = "held" /\ parts[a])))
     THEN phase' = Set(phase, a, "work") /\ UNCHANGED outcome
     ELSE phase' = Set(phase, a, "fhold") /\ outcome' = Set(outcome, a, "bad")
  /\ UNCHANGED <<rar, ledger, dropped, evicted, whole, split, parts, rows, work, retried, capPending, evictPending,
                 unrecorded, capActive, crashes, downloads>>
RemoveWork(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "work" /\ work' = Set(work, a, FALSE)
                 /\ phase' = Set(phase, a, IF LedgerFirst THEN "ledger" ELSE "rar")
                 /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, retried,
                                capPending, evictPending, unrecorded, capActive, crashes, downloads>>
\* the RAR goes (a retried failure's whole failed/ folder with it)
RemoveRar(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "rar" /\ rar' = Set(rar, a, "gone")
                /\ phase' = Set(phase, a, IF LedgerFirst THEN "idle" ELSE "ledger")
                /\ UNCHANGED <<ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                               capPending, evictPending, unrecorded, capActive, crashes, downloads>>
\* the done row
LedgerDone(a) == /\ ~Busy /\ Alone(a) /\ phase[a] = "ledger" /\ ledger' = Set(ledger, a, "done")
                 /\ phase' = Set(phase, a, IF LedgerFirst THEN "rar" ELSE "idle")
                 /\ UNCHANGED <<rar, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                                capPending, evictPending, unrecorded, capActive, crashes, downloads>>
\* with LedgerFirst, a start deletes a done archive's leftover RAR (modelled whenever it is not in flight)
Recover(a) == /\ ~Busy /\ Alone(a) /\ LedgerFirst /\ phase[a] = "idle" /\ ledger[a] = "done" /\ rar[a] # "gone"
              /\ rar' = Set(rar, a, "gone")
              /\ UNCHANGED <<phase, ledger, dropped, evicted, outcome, whole, split, parts, rows, work, retried,
                             capPending, evictPending, unrecorded, capActive, crashes, downloads>>

\* ---------------------------------------------------------------- enforce_parts_cap (1376-1403)

\* inside any archive's stitch_parts, for a held map whose archive is not in flight: the code deletes the parts,
\* then writes the expired row; ExpiryRowFirst swaps the two
CapFirst(x) ==
  /\ ~Busy
  /\ CapPressure /\ \E b \in Archives : phase[b] \in InCall
  /\ split[x] = "held" /\ parts[x] /\ x \notin Active /\ x \notin capPending
  /\ capPending' = capPending \cup {x}
  /\ IF ExpiryRowFirst
     THEN /\ rows' = Set(rows, x, rows[x] \cup {"expired"}) /\ split' = Set(split, x, "expired")
          /\ UNCHANGED <<parts, unrecorded>>
     ELSE /\ parts' = Set(parts, x, FALSE) /\ unrecorded' = unrecorded \cup {x}
          /\ UNCHANGED <<rows, split>>
  /\ capActive' = capActive \/ (x \in Active)
  /\ UNCHANGED <<phase, rar, ledger, dropped, evicted, outcome, whole, work, retried, evictPending, crashes,
                 downloads>>
CapSecond(x) ==
  /\ x \in capPending
  /\ capPending' = capPending \ {x}
  /\ IF ExpiryRowFirst
     THEN /\ parts' = Set(parts, x, FALSE) /\ UNCHANGED <<rows, split, unrecorded>>
     ELSE /\ rows' = Set(rows, x, rows[x] \cup {"expired"}) /\ split' = Set(split, x, "expired")
          /\ unrecorded' = unrecorded \ {x} /\ UNCHANGED parts
  /\ UNCHANGED <<phase, rar, ledger, dropped, evicted, outcome, whole, work, retried, evictPending, capActive,
                 crashes, downloads>>

\* ---------------------------------------------------------------- the world

\* the process dies anywhere: in-memory state goes; a restart deletes leftover work folders
Crash ==
  /\ crashes < Crashes /\ crashes' = crashes + 1
  /\ phase' = [a \in Archives |-> "idle"]
  /\ retried' = {} /\ capPending' = {} /\ evictPending' = {}
  /\ work' = [a \in Archives |-> FALSE]
  /\ UNCHANGED <<rar, ledger, dropped, evicted, outcome, whole, split, parts, rows, unrecorded, capActive, downloads>>

\* the user downloads a deleted archive again
Redownload(a) == /\ downloads < Redownloads /\ rar[a] = "gone" /\ phase[a] = "idle"
                 /\ rar' = Set(rar, a, "downloads") /\ downloads' = downloads + 1
                 \* a new copy: what failed_dropped.jsonl says of the old one excuses nothing about this one
                 /\ dropped' = Set(dropped, a, FALSE) /\ evicted' = Set(evicted, a, FALSE)
                 /\ UNCHANGED <<phase, ledger, outcome, whole, split, parts, rows, work, retried,
                                capPending, evictPending, unrecorded, capActive, crashes>>

\* the main loop is single-threaded: while enforce_parts_cap or enforce_failed_cap is between its two steps on
\* an archive, it takes no other step (every main-loop action is guarded by ~Busy); only a crash, or the user,
\* comes in between
Next ==
  \/ \E a \in Archives :
       \/ Scan(a) \/ Hash(a) \/ Extract(a) \/ Parse(a) \/ ToFail(a) \/ Stitch(a) \/ Check(a)
       \/ RemoveWork(a) \/ RemoveRar(a) \/ LedgerDone(a) \/ Recover(a)
       \/ FailHold(a) \/ FailDrop(a) \/ FailDelete(a) \/ FailMove(a) \/ FailWrite(a) \/ FailLedger(a) \/ FailDone(a)
       \/ EvictRecord(a) \/ EvictDelete(a) \/ CapFirst(a) \/ CapSecond(a) \/ Redownload(a)
  \/ Crash

Spec == Init /\ [][Next]_vars
\* archives are interchangeable, so a configuration naming them as model values can check one ordering
Symmetry == Permutations(Archives)

\* ---------------------------------------------------------------- properties

TypeOK == /\ phase \in [Archives -> Phases]
          /\ rar \in [Archives -> {"downloads", "failed", "gone"}]
          /\ ledger \in [Archives -> {"none", "done", "failed", "evicted"}]
          /\ split \in [Archives -> {"none", "stitched", "broken", "held", "expired"}]

\* no archive is deleted with a map unaccounted unless failed_dropped.jsonl records it: once its RAR is gone, its
\* whole map is published and its split map is stitched, expired with a row, or held with its parts (or the cap is
\* between its two steps on it)
NoUnaccountedDeletion ==
  \A a \in Archives : (rar[a] = "gone" /\ ~dropped[a])
    => whole[a] /\ (split[a] \in {"stitched", "expired"} \/ (split[a] = "held" /\ (parts[a] \/ a \in capPending)))
\* every deletion of held parts has its expired row, but for the moment between the cap's two steps
ExpiredRecorded == \A a \in Archives : a \in unrecorded => a \in capPending
\* the cap never deletes the parts of an archive still in flight
CapSparesActive == ~capActive
\* a failure whose last row says failed still has its RAR (in failed/, or a new download of it), unless
\* failed_dropped.jsonl records it as deleted
FailedKept == \A a \in Archives : (ledger[a] = "failed" /\ phase[a] = "idle" /\ ~dropped[a]) => rar[a] # "gone"
\* an archive whose RAR is gone has a done row or a failed_dropped record: none is published with no row
DeletedRecorded ==
  \A a \in Archives : (rar[a] = "gone" /\ phase[a] \notin {"ledger", "fledger"}) => ledger[a] = "done" \/ dropped[a]
\* an evicted failure can be downloaded and extracted again: its last ledger row does not make scan skip it
EvictedRedownloadable == \A a \in Archives : (evicted[a] /\ phase[a] = "idle") => ledger[a] # "failed"
=============================================================================
