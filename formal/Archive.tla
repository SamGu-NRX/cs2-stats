------------------------------- MODULE Archive -------------------------------
(***************************************************************************)
(* The demo pipeline's archive lifecycle (extractor/demo_pipeline.py):      *)
(* scan, hashing, pending, extracting, parsing, then finish_archives with   *)
(* stitching or holding split maps, the unaccounted check, removing the     *)
(* work folder and the RAR, and the ledger row; or fail_archive, which      *)
(* keeps the RAR in failed/ for --retry-failed or drops a truncated one;    *)
(* and enforce_parts_cap, which deletes the held parts of archives no       *)
(* longer in flight. The pipeline is one process (its HTTP port admits one  *)
(* instance) whose main loop runs these steps one at a time; it can crash   *)
(* between any two, losing its in-memory archives, and a restart deletes    *)
(* leftover work folders and scans again.                                   *)
(*                                                                         *)
(* Abstractions: each archive holds one whole map and one map recorded as   *)
(* two parts; a worker's outcome is one value per archive (every demo ok,   *)
(* some failing, or all truncated), and an ok whole map is published by its *)
(* worker before the archive finishes. Publication versions, CURRENT and    *)
(* readers are Publish.tla's; replace_old_extractions is abstracted away.   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Archives,      \* e.g. {1, 2}
  Crashes,       \* pipeline crashes allowed in a behaviour
  RetryFailed,   \* the run uses --retry-failed
  CapPressure,   \* parts/ can pass MAX_PARTS_GB, so enforce_parts_cap deletes held parts
  WorkerFails,   \* a parse can fail or be truncated, and a stitch can leave no complete map
  CheckFirst,    \* finish_archives runs unaccounted() before deleting anything; FALSE skips it (a regression)
  LedgerFirst    \* the done row is written before the RAR goes, and a start deletes a done archive's leftover
                 \* RAR (recover_finished); FALSE is the order before, RAR first and no recovery

Phases == {"idle", "hashing", "pending", "extracting", "parsing", "stitch", "check", "work", "rar", "ledger"}

VARIABLES
  phase,     \* phase[a]: where the main loop has it; "idle" when not in self.archives
  rar,       \* rar[a] \in {"downloads", "failed", "gone"}
  ledger,    \* ledger[a] \in {"none", "done", "failed", "dropped"}
  outcome,   \* outcome[a] \in {"none", "ok", "bad", "truncated"}: this attempt's worker results
  whole,     \* whole[a]: the whole map is published (resolves)
  split,     \* split[a] \in {"none", "stitched", "broken", "held", "expired"}: the split map, per parts.jsonl;
             \* "broken" is a stitch that reported success but left no complete map
  parts,     \* parts[a]: the split map's part folders hold their tables
  rows,      \* rows[a]: parts.jsonl statuses written for the archive
  work,      \* work[a]: the archive's extracted demos are on disk
  retried,   \* self.retried: failed/ archives already tried in this run
  capActive, \* ghost: the cap deleted parts of an archive in flight
  crashes

vars == <<phase, rar, ledger, outcome, whole, split, parts, rows, work, retried, capActive, crashes>>

Init ==
  /\ phase = [a \in Archives |-> "idle"]
  /\ rar = [a \in Archives |-> "downloads"]
  /\ ledger = [a \in Archives |-> "none"]
  /\ outcome = [a \in Archives |-> "none"]
  /\ whole = [a \in Archives |-> FALSE]
  /\ split = [a \in Archives |-> "none"]
  /\ parts = [a \in Archives |-> FALSE]
  /\ rows = [a \in Archives |-> {}]
  /\ work = [a \in Archives |-> FALSE]
  /\ retried = {}
  /\ capActive = FALSE
  /\ crashes = 0

Active == {a \in Archives : phase[a] # "idle"}
Set(f, a, v) == [f EXCEPT ![a] = v]

\* scan(): a downloads RAR the ledger has not finished or failed, or (with --retry-failed) a failed/ RAR not
\* yet tried in this run; due_for_retry is assumed true
Scan(a) ==
  /\ phase[a] = "idle"
  /\ \/ rar[a] = "downloads" /\ ledger[a] \notin {"done", "failed", "dropped"}
     \/ RetryFailed /\ rar[a] = "failed" /\ ledger[a] = "failed" /\ a \notin retried
  /\ phase' = Set(phase, a, "hashing")
  /\ retried' = IF rar[a] = "failed" THEN retried \cup {a} ELSE retried
  /\ outcome' = Set(outcome, a, "none")
  /\ UNCHANGED <<rar, ledger, whole, split, parts, rows, work, capActive, crashes>>

Hash(a) == /\ phase[a] = "hashing" /\ phase' = Set(phase, a, "pending")
           /\ UNCHANGED <<rar, ledger, outcome, whole, split, parts, rows, work, retried, capActive, crashes>>
Extract(a) == /\ phase[a] = "pending" /\ phase' = Set(phase, a, "extracting") /\ work' = Set(work, a, TRUE)
              /\ UNCHANGED <<rar, ledger, outcome, whole, split, parts, rows, retried, capActive, crashes>>

\* the workers parse every demo: an ok whole map is published and an ok part is written to parts/
Parse(a) ==
  /\ phase[a] = "extracting"
  /\ \E o \in (IF WorkerFails THEN {"ok", "bad", "truncated"} ELSE {"ok"}) :
       /\ outcome' = Set(outcome, a, o)
       /\ whole' = IF o = "ok" THEN Set(whole, a, TRUE) ELSE whole
       /\ parts' = IF o = "ok" THEN Set(parts, a, TRUE) ELSE parts
  /\ phase' = Set(phase, a, "parsing")
  /\ UNCHANGED <<rar, ledger, split, rows, work, retried, capActive, crashes>>

\* fail_archive: hold the split map with the failure as its reason; keep the RAR in failed/ (retryable) or,
\* when every failing demo was truncated, drop it with a failed_dropped row
Fail(a) ==
  /\ phase[a] = "parsing" /\ outcome[a] \in {"bad", "truncated"}
  /\ rows' = Set(rows, a, rows[a] \cup {"held"})
  /\ split' = Set(split, a, "held")
  /\ IF outcome[a] = "truncated"
     THEN rar' = Set(rar, a, "gone") /\ ledger' = Set(ledger, a, "dropped")
     ELSE rar' = Set(rar, a, "failed") /\ ledger' = Set(ledger, a, "failed")
  /\ work' = Set(work, a, FALSE)
  /\ phase' = Set(phase, a, "idle")
  /\ UNCHANGED <<outcome, whole, parts, retried, capActive, crashes>>

\* finish_archives, step by step. stitch_parts: the split map is stitched into demos/ (its parts deleted) or
\* held with its parts; either way parts.jsonl says so
Stitch(a) ==
  /\ phase[a] = "parsing" /\ outcome[a] = "ok"
  /\ \E s \in (IF WorkerFails THEN {"stitched", "broken", "held"} ELSE {"stitched", "held"}) :
       /\ split' = Set(split, a, s)
       /\ rows' = Set(rows, a, rows[a] \cup {IF s = "broken" THEN "stitched" ELSE s})
       /\ parts' = IF s = "held" THEN parts ELSE Set(parts, a, FALSE)
  /\ phase' = Set(phase, a, "check")
  /\ UNCHANGED <<rar, ledger, outcome, whole, work, retried, capActive, crashes>>

\* unaccounted(): every whole map resolves, every stitched map resolves, every held map keeps its parts;
\* otherwise the archive fails and its RAR stays
Check(a) ==
  /\ phase[a] = "check"
  /\ IF ~CheckFirst \/ (whole[a] /\ (split[a] = "stitched" \/ (split[a] = "held" /\ parts[a])))
     THEN phase' = Set(phase, a, "work") /\ UNCHANGED <<rar, ledger, work>>
     ELSE /\ rar' = Set(rar, a, "failed") /\ ledger' = Set(ledger, a, "failed")
          /\ work' = Set(work, a, FALSE) /\ phase' = Set(phase, a, "idle")
  /\ UNCHANGED <<outcome, whole, split, parts, rows, retried, capActive, crashes>>

RemoveWork(a) == /\ phase[a] = "work" /\ work' = Set(work, a, FALSE)
                 /\ phase' = Set(phase, a, IF LedgerFirst THEN "ledger" ELSE "rar")
                 /\ UNCHANGED <<rar, ledger, outcome, whole, split, parts, rows, retried, capActive, crashes>>
\* the RAR goes (a retried failure's whole failed/ folder with it)
RemoveRar(a) == /\ phase[a] = "rar" /\ rar' = Set(rar, a, "gone")
                /\ phase' = Set(phase, a, IF LedgerFirst THEN "idle" ELSE "ledger")
                /\ UNCHANGED <<ledger, outcome, whole, split, parts, rows, work, retried, capActive, crashes>>
\* the ledger's done row (with LedgerFirst, before the RAR goes)
LedgerDone(a) == /\ phase[a] = "ledger" /\ ledger' = Set(ledger, a, "done")
                 /\ phase' = Set(phase, a, IF LedgerFirst THEN "rar" ELSE "idle")
                 /\ UNCHANGED <<rar, outcome, whole, split, parts, rows, work, retried, capActive, crashes>>
\* recover_finished, at a start: a done archive whose RAR is still there loses it. Modelled as possible
\* whenever the archive is not in flight, a superset of "at a start"
Recover(a) == /\ LedgerFirst /\ phase[a] = "idle" /\ ledger[a] = "done" /\ rar[a] # "gone"
              /\ rar' = Set(rar, a, "gone")
              /\ UNCHANGED <<phase, ledger, outcome, whole, split, parts, rows, work, retried, capActive, crashes>>

\* enforce_parts_cap, run inside any archive's stitch_parts: delete a held map's parts unless its archive is
\* in flight, with an expired row
Cap(a) ==
  /\ CapPressure /\ Active # {} /\ split[a] = "held" /\ parts[a] /\ a \notin Active
  /\ parts' = Set(parts, a, FALSE) /\ split' = Set(split, a, "expired")
  /\ rows' = Set(rows, a, rows[a] \cup {"expired"})
  /\ capActive' = capActive \/ (a \in Active)
  /\ UNCHANGED <<phase, rar, ledger, outcome, whole, work, retried, crashes>>

\* the process dies anywhere; the restart forgets self.archives and self.retried and deletes leftover work
Crash ==
  /\ crashes < Crashes /\ crashes' = crashes + 1
  /\ phase' = [a \in Archives |-> "idle"]
  /\ retried' = {}
  /\ work' = [a \in Archives |-> FALSE]
  /\ UNCHANGED <<rar, ledger, outcome, whole, split, parts, rows, capActive>>

Next ==
  \/ \E a \in Archives : Scan(a) \/ Hash(a) \/ Extract(a) \/ Parse(a) \/ Fail(a) \/ Stitch(a) \/ Check(a)
                         \/ RemoveWork(a) \/ RemoveRar(a) \/ LedgerDone(a) \/ Cap(a) \/ Recover(a)
  \/ Crash

Spec == Init /\ [][Next]_vars
\* archives are interchangeable, so a configuration naming them as model values can check one ordering
Symmetry == Permutations(Archives)

TypeOK == /\ phase \in [Archives -> Phases]
          /\ rar \in [Archives -> {"downloads", "failed", "gone"}]
          /\ split \in [Archives -> {"none", "stitched", "broken", "held", "expired"}]

\* no archive is deleted while a map of it is unaccounted: once its RAR is gone (and it was not dropped as
\* truncated), its whole map is published and its split map is stitched, held with its parts, or expired by
\* the cap with a row saying so
NoUnaccountedDeletion ==
  \A a \in Archives : (rar[a] = "gone" /\ ledger[a] # "dropped")
    => whole[a] /\ (split[a] \in {"stitched", "expired"} \/ (split[a] = "held" /\ parts[a]))
\* every deletion of held parts is recorded
ExpiredRecorded == \A a \in Archives : split[a] = "expired" => "expired" \in rows[a]
\* the cap never deletes the parts of an archive still in flight
CapSparesActive == ~capActive
\* a retryable failure keeps its RAR in failed/ (checked without crashes; DeletedRecorded covers the crash)
FailedKept == \A a \in Archives : (ledger[a] = "failed" /\ phase[a] = "idle") => rar[a] = "failed"
\* an archive whose RAR is gone is in the ledger, as done or dropped: no archive has its maps published and its
\* RAR deleted without a row. Before LedgerFirst, a crash between deleting the RAR and appending the done row
\* broke it (ArchiveLegacyLedgerOrder)
DeletedRecorded == \A a \in Archives : (rar[a] = "gone" /\ phase[a] # "ledger") => ledger[a] \in {"done", "dropped"}
=============================================================================
