---------------------------- MODULE Capture ----------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC
CONSTANTS Rounds, Epochs, Reload, ScanRace

\* Round rows use indices, as MatchStore.SetRound does, not append-only rows.
\* Full event payloads are abstracted away; partial marks are retained.
R == 0..(Rounds - 1)
E == 1..Epochs
EmptyFile == [exists |-> FALSE, rows |-> {}, partial |-> {}, whole |-> TRUE]
Job(e, rows, partial, final) ==
    [epoch |-> e, rows |-> rows, partial |-> partial, final |-> final]
VARIABLE s
vars == <<s>>
Init == s = [epoch |-> 1, played |-> 0, phase |-> "warmup",
    loaded |-> "on", reloaded |-> FALSE, human |-> TRUE,
    capturing |-> FALSE, id |-> 1, ri |-> -1, finalized |-> FALSE,
    partial |-> {}, buf |-> {}, eventSeen |-> FALSE, endPending |-> FALSE,
    completed |-> [e \in E |-> {}], interrupted |-> [e \in E |-> {}],
    expected |-> [e \in E |-> {}], normalEnd |-> {},
    q |-> <<>>, worker |-> "idle", storeId |-> 1,
    storeRows |-> {}, storePartial |-> {}, job |-> Job(1, {}, {}, FALSE),
    progress |-> [e \in E |-> EmptyFile], final |-> [e \in E |-> EmptyFile],
    writes |-> [e \in E |-> 0], request |-> 1,
    response |-> EmptyFile, resumedWrong |-> FALSE]

\* The old round is finalized before BeginRound; Flush has no round payload.
RoundStart ==
    /\ s.phase \in {"warmup", "post"} /\ s.played < Rounds /\ s.loaded # "unloading"
    /\ LET recording == s.loaded = "on" /\ s.human
           prior == IF s.capturing /\ s.ri >= 0 /\ ~s.finalized THEN {s.ri} ELSE {}
           newId == IF s.capturing THEN s.id ELSE s.epoch
       IN s' = [s EXCEPT !.phase = "freeze", !.eventSeen = FALSE,
          !.capturing = IF recording THEN TRUE ELSE @,
          !.id = IF recording THEN newId ELSE @,
          !.ri = IF recording THEN s.played ELSE @,
          !.finalized = IF recording THEN FALSE ELSE @,
          !.buf = IF recording THEN {} ELSE @,
          !.partial = IF recording /\ ~s.capturing THEN 0..(s.played-1) ELSE @,
          !.q = IF recording /\ s.capturing
                THEN Append(@, Job(s.id, s.buf \cup prior, s.partial, FALSE))
                ELSE IF recording /\ s.played > 0
                     THEN Append(@, Job(newId, 0..(s.played-1), 0..(s.played-1), FALSE)) ELSE @]
FreezeEnd ==
    /\ s.phase = "freeze" /\ s.loaded # "unloading"
    /\ s' = [s EXCEPT !.phase = "live"]
Event ==
    /\ s.phase = "live" /\ ~s.eventSeen
    /\ s' = [s EXCEPT !.eventSeen = TRUE]
RoundEnd ==
    /\ s.phase = "live" /\ s.loaded # "unloading"
    /\ s' = [s EXCEPT !.phase = "post", !.played = @ + 1,
                      !.completed[s.epoch] = @ \cup {s.played}]
FinalizeTimer ==
    /\ s.loaded = "on" /\ s.capturing /\ s.phase = "post"
    /\ s.ri >= 0 /\ ~s.finalized
    /\ s' = [s EXCEPT !.finalized = TRUE, !.buf = {},
           !.q = Append(@, Job(s.id, s.buf \cup {s.ri}, s.partial, FALSE))]
WinPanel ==
    /\ s.phase = "post" /\ s.played = Rounds /\ s.epoch \notin s.normalEnd /\ s.human
    /\ s.loaded # "unloading"
    /\ s' = [s EXCEPT !.normalEnd = @ \cup {s.epoch},
                     !.endPending = s.loaded = "on" /\ s.capturing]

\* Normal completion finalizes; abandonment seals an open row as partial.
Close(kind) ==
    /\ s.loaded = "on" /\ s.capturing
    /\ LET open == s.ri >= 0 /\ ~s.finalized
           rows == s.buf \cup (IF open THEN {s.ri} ELSE {})
           p == s.partial \cup (IF open /\ kind \notin {"complete","mapcomplete","disconnectcomplete"} THEN {s.ri} ELSE {})
       IN s' = [s EXCEPT !.capturing = FALSE, !.ri = -1, !.buf = {},
          !.phase = IF kind = "complete" THEN "ended" ELSE IF kind \in {"map","mapcomplete"} THEN "mapgone" ELSE "closed",
          !.endPending = FALSE,
          !.human = IF kind \in {"disconnect","disconnectcomplete"} THEN FALSE ELSE @,
          !.expected[s.id] = s.completed[s.epoch],
          !.q = Append(@, Job(s.id, rows, p, TRUE))]
EndMatch == /\ s.endPending /\ Close("complete")
MapEnd == Close(IF s.endPending THEN "mapcomplete" ELSE "map")
Disconnect == Close(IF s.endPending THEN "disconnectcomplete" ELSE "disconnect")

\* Restart's round_start is ignored while _scanPending is true.
Restart ==
    /\ s.epoch < Epochs /\ s.phase # "warmup"
    /\ (s.loaded = "on" \/ (ScanRace /\ s.loaded \in {"scanning", "response"}))
    /\ LET open == s.capturing /\ s.ri >= 0 /\ ~s.finalized
           rows == s.buf \cup (IF open THEN {s.ri} ELSE {})
           p == s.partial \cup (IF open THEN {s.ri} ELSE {})
       IN s' = [s EXCEPT !.epoch = @ + 1, !.played = 0, !.phase = "warmup",
          !.capturing = FALSE, !.ri = -1, !.buf = {}, !.partial = {},
          !.endPending = FALSE,
          !.expected[s.id] = IF s.capturing THEN s.completed[s.epoch] ELSE @,
          !.q = IF s.capturing THEN Append(@, Job(s.id, rows, p, TRUE)) ELSE @]

\* Graceful hot unload can start at any worker phase, including a partial tmp.
\* It flushes events, but does NOT seal the active round (Recorder.Flush).
Unload ==
    /\ Reload /\ ~s.reloaded /\ s.loaded = "on" /\ s.capturing /\ s.phase # "warmup"
    /\ s' = [s EXCEPT !.loaded = "unloading", !.reloaded = TRUE,
       !.interrupted[s.id] = IF s.capturing /\ s.ri >= 0 /\ ~s.finalized
                             THEN @ \cup {s.ri} ELSE @,
       !.q = IF s.capturing THEN Append(@, Job(s.id, s.buf, s.partial, FALSE)) ELSE @,
       !.buf = {}, !.capturing = FALSE, !.ri = -1, !.endPending = FALSE]
Load ==
    /\ s.loaded = "unloading" /\ s.worker = "idle" /\ s.q = <<>>
    /\ s' = [s EXCEPT !.loaded = "scanning", !.request = s.epoch,
                      !.storeRows = {}, !.storePartial = {}]
\* Stale scan files take the same complete-file replacement path, collapsed
\* here to one step. Different epochs have distinct gameStart values.
Scan ==
    /\ s.loaded = "scanning"
    /\ s' = [s EXCEPT !.loaded = "response", !.response = s.progress[s.request],
       !.final = [e \in E |-> IF e # s.request /\ s.progress[e].exists /\ s.progress[e].rows # {}
                             THEN s.progress[e] ELSE s.final[e]],
       !.writes = [e \in E |-> s.writes[e] +
                 (IF e # s.request /\ s.progress[e].exists /\ s.progress[e].rows # {} THEN 1 ELSE 0)],
       !.progress = [e \in E |-> IF e # s.request THEN EmptyFile ELSE s.progress[e]]]
Resume ==
    /\ s.loaded = "response"
    /\ LET found == s.response.exists
           canStart == found \/ (s.phase \in {"freeze","live","post","ended"} /\ s.human)
           mid == s.phase \in {"freeze", "live"}
           count == Cardinality(s.response.rows)
           prior == (IF found THEN count ELSE 0)..(s.played-1)
       IN s' = [s EXCEPT !.loaded = "on", !.capturing = canStart,
          !.id = IF found THEN s.request ELSE s.epoch,
          !.ri = IF canStart /\ mid /\ count <= s.played THEN s.played ELSE -1,
          !.finalized = FALSE, !.buf = prior,
          !.partial = s.response.partial \cup prior \cup
                      (IF canStart /\ mid /\ count <= s.played THEN {s.played} ELSE {}),
          !.storeId = IF found THEN s.request ELSE s.epoch,
          !.storeRows = s.response.rows, !.storePartial = s.response.partial,
          !.resumedWrong = @ \/ (found /\ s.request # s.epoch)]

\* One FIFO worker; tmp may be incomplete until Encode finishes. Only Move
\* publishes it. Final publication and deletion of inprogress are separate.
TakeJob ==
    /\ s.worker = "idle" /\ Len(s.q) > 0
    /\ LET j == Head(s.q)
       IN s' = [s EXCEPT !.q = Tail(@), !.job = j, !.worker = "tmp",
          !.storeId = j.epoch,
          !.storeRows = (IF s.storeId = j.epoch THEN s.storeRows ELSE {}) \cup j.rows,
          !.storePartial = j.partial]
Encode == /\ s.worker = "tmp" /\ s' = [s EXCEPT !.worker = "ready"]
Publish ==
    /\ s.worker = "ready"
    /\ LET f == [exists |-> TRUE, rows |-> s.storeRows,
                 partial |-> s.storePartial, whole |-> TRUE]
       IN s' = [s EXCEPT !.worker = IF s.job.final THEN "cleanup" ELSE "idle",
          !.progress[s.job.epoch] = IF ~s.job.final THEN f ELSE @,
          !.final[s.job.epoch] = IF s.job.final /\ s.storeRows # {} THEN f ELSE @,
          !.writes[s.job.epoch] = @ + (IF s.job.final /\ s.storeRows # {} THEN 1 ELSE 0)]
Cleanup ==
    /\ s.worker = "cleanup"
    /\ s' = [s EXCEPT !.worker = "idle", !.progress[s.job.epoch] = EmptyFile,
                      !.storeRows = {}, !.storePartial = {}]
Worker == TakeJob \/ Encode \/ Publish \/ Cleanup
Next == RoundStart \/ FreezeEnd \/ Event \/ RoundEnd \/ FinalizeTimer \/ WinPanel
        \/ EndMatch \/ MapEnd \/ Disconnect \/ Restart \/ Unload \/ Load \/ Scan \/ Resume \/ Worker
Spec == Init /\ [][Next]_vars /\ WF_vars(Worker) /\ WF_vars(EndMatch)
        /\ WF_vars(Load) /\ WF_vars(Scan) /\ WF_vars(Resume)

TypeOK == /\ s.epoch \in E /\ s.played \in 0..Rounds
          /\ s.ri \in {-1} \cup R
          /\ \A e \in E : s.final[e].rows \subseteq R /\ s.progress[e].rows \subseteq R
\* Sets are faithful here: SetRound replaces by index; duplicate event rows
\* and column serialization are outside this lifecycle abstraction.
CompletedExactlyOnce == \A e \in E : s.final[e].exists => s.expected[e] \subseteq s.final[e].rows
ReloadAccounted == \A e \in E : s.final[e].exists =>
    (s.expected[e] \subseteq s.final[e].rows /\
     (s.interrupted[e] \cap s.final[e].rows) \subseteq s.final[e].partial)
Parseable == \A e \in E : s.progress[e].whole /\ s.final[e].whole
FinalAtMostOnce == \A e \in E : s.writes[e] <= 1
SameMatchResume == ~s.resumedWrong
NormalEventuallyFinal == \A e \in E : (e \in s.normalEnd) ~> s.final[e].exists
=============================================================================
