---------------------------- MODULE Pipeline ----------------------------
EXTENDS Naturals, TLC
CONSTANTS Invalidated, Collision, RefeedDone, TornQueue, Crashes
VARIABLE s
vars == <<s>>
Init == s = [pc |-> IF RefeedDone THEN "scan" ELSE "publish", valid |-> FALSE,
  ok |-> FALSE, oldMarker |-> "stale: reason", oldData |-> TRUE,
  staged |-> FALSE, row |-> TRUE, otherRow |-> TRUE, fed |-> RefeedDone,
  ledgerDone |-> RefeedDone, job |-> FALSE, invalidated |-> FALSE, crashed |-> FALSE]
FeedScan ==
 /\ s.pc = "scan"
 /\ s' = [s EXCEPT !.job = ~s.ledgerDone,
                   !.pc = IF s.ledgerDone THEN "done" ELSE "publish"]
Publish == /\ s.pc = "publish"
           /\ s' = [s EXCEPT !.valid = TRUE, !.job = TRUE, !.pc = "check"]
Check == /\ s.pc = "check"
         /\ s' = [s EXCEPT !.ok = s.valid, !.pc = "retireStage"]
Invalidate ==
 /\ Invalidated /\ s.valid /\ ~s.invalidated
 /\ s' = [s EXCEPT !.valid = FALSE, !.invalidated = TRUE]
StageRetire ==
 /\ s.pc = "retireStage"
 /\ s' = [s EXCEPT !.staged = s.ok,
                   !.pc = IF s.ok THEN "retireReplace" ELSE "done"]
ReplaceRetire ==
 /\ s.pc = "retireReplace" /\ s.staged
 /\ s' = [s EXCEPT !.oldMarker = "replaced", !.staged = FALSE, !.pc = "delete"]
DeleteOld ==
 /\ s.pc = "delete"
 /\ s' = [s EXCEPT !.oldData = FALSE, !.pc = "queueOpen"]
\* write_text opens with truncation: unrelated unresolved rows can be lost
\* if a crash interrupts the rewrite, unlike an atomic os.replace.
QueueOpen ==
 /\ s.pc = "queueOpen"
 /\ s' = [s EXCEPT !.row = FALSE, !.otherRow = IF TornQueue THEN FALSE ELSE @,
                   !.pc = "queueWrite"]
QueueWrite == /\ s.pc = "queueWrite"
              /\ s' = [s EXCEPT !.otherRow = TRUE, !.pc = "done"]
Crash == /\ Crashes /\ ~s.crashed /\ s' = [s EXCEPT !.crashed = TRUE]
Work == FeedScan \/ Publish \/ Check \/ Invalidate \/ StageRetire \/ ReplaceRetire
        \/ DeleteOld \/ QueueOpen \/ QueueWrite
Next == (/\ ~s.crashed /\ Work) \/ Crash
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Work)
TypeOK == s.oldMarker \in {"stale: reason","replaced"}
ReplacementBeforeDelete == ~s.oldData => s.valid /\ ~Collision
StaleKept == s.oldMarker = "stale: reason" => s.oldData
CrashQueuePreserved == s.crashed => s.otherRow
RefeedEventuallyProcessed == s.fed ~> s.job
=============================================================================
