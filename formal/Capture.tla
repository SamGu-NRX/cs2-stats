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
    winSeen |-> FALSE, gameEnded |-> FALSE, startedAfterEnd |-> FALSE,
    completed |-> [e \in E |-> {}], interrupted |-> [e \in E |-> {}],
    expected |-> [e \in E |-> {}], normalEnd |-> {}, abandoned |-> {},
    q |-> <<>>, worker |-> "idle", storeId |-> 1,
    storeRows |-> {}, storePartial |-> {}, job |-> Job(1, {}, {}, FALSE),
    progress |-> [e \in E |-> EmptyFile], final |-> [e \in E |-> EmptyFile],
    writes |-> [e \in E |-> 0],
    scanGen |-> 0, workerGen |-> 0, requestEpoch |-> 1, workerEpoch |-> 1,
    responseGen |-> 0, responseEpoch |-> 1, response |-> EmptyFile,
    rescanCount |-> 0, resumedWrong |-> FALSE]

\* The old round is finalized before BeginRound; Flush has no round payload.
\* A round_start cannot start a new capture after the remembered win panel.
RoundStart ==
    /\ s.phase \in {"warmup", "post"} /\ s.played < Rounds
    /\ s.loaded = "on" /\ ~s.winSeen
    /\ LET recording == s.human
           prior == IF s.capturing /\ s.ri >= 0 /\ ~s.finalized THEN {s.ri} ELSE {}
           newId == IF s.capturing THEN s.id ELSE s.epoch
       IN s' = [s EXCEPT !.phase = "freeze", !.eventSeen = FALSE,
          !.capturing = recording,
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
    /\ s.phase = "freeze" /\ s.loaded = "on" /\ s.capturing
    /\ s' = [s EXCEPT !.phase = "live"]
Event ==
    /\ s.phase = "live" /\ s.loaded = "on" /\ s.capturing /\ ~s.eventSeen
    /\ s' = [s EXCEPT !.eventSeen = TRUE]
RoundEnd ==
    /\ s.phase = "live" /\ s.loaded = "on" /\ s.capturing
    /\ s' = [s EXCEPT !.phase = "post", !.played = @ + 1,
                      !.completed[s.epoch] = @ \cup {s.played}]
FinalizeTimer ==
    /\ s.loaded = "on" /\ s.capturing /\ s.phase = "post"
    /\ s.ri >= 0 /\ ~s.finalized
    /\ s' = [s EXCEPT !.finalized = TRUE, !.buf = {},
           !.q = Append(@, Job(s.id, s.buf \cup {s.ri}, s.partial, FALSE))]

\* cs_win_panel_match is remembered even when capture is unavailable.
WinPanel ==
    /\ s.phase = "post" /\ s.played = Rounds /\ ~s.winSeen /\ ~s.gameEnded
    /\ s' = [s EXCEPT !.winSeen = TRUE, !.gameEnded = TRUE,
                     !.normalEnd = @ \cup {s.epoch},
                     !.endPending = IF s.loaded = "on" /\ s.capturing THEN TRUE ELSE @]

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

\* A restart during a pending scan starts a new scan generation. The old worker
\* response remains queued and must be ignored by DrainMessages.
Restart ==
    /\ s.epoch < Epochs /\ s.phase # "warmup"
    /\ (s.loaded = "on" \/ (ScanRace /\ s.loaded \in {"scanning", "response"}))
    /\ LET open == s.capturing /\ s.ri >= 0 /\ ~s.finalized
           rows == s.buf \cup (IF open THEN {s.ri} ELSE {})
           p == s.partial \cup (IF open THEN {s.ri} ELSE {})
           scanning == s.loaded \in {"scanning", "response"}
       IN s' = [s EXCEPT !.epoch = @ + 1, !.played = 0, !.phase = "warmup",
          !.capturing = FALSE, !.ri = -1, !.buf = {}, !.partial = {},
          !.endPending = FALSE, !.winSeen = FALSE, !.gameEnded = FALSE,
          !.scanGen = IF scanning THEN @ + 1 ELSE @,
          !.requestEpoch = IF scanning THEN @ + 1 ELSE @,
          !.expected[s.id] = IF s.capturing THEN s.completed[s.epoch] ELSE @,
          !.q = IF s.capturing THEN Append(@, Job(s.id, rows, p, TRUE)) ELSE @]

\* A live identity change discovered after a scan response exercises
\* Lifecycle.AcceptResume's rejection path without pretending the old answer is current.
IdentityDrift ==
    /\ ScanRace /\ s.loaded = "response" /\ s.epoch < Epochs
    /\ s' = [s EXCEPT !.epoch = @ + 1, !.played = 0, !.phase = "warmup",
          !.capturing = FALSE, !.ri = -1, !.buf = {}, !.winSeen = FALSE,
          !.gameEnded = FALSE]

\* Graceful hot unload can start mid-round or while a worker write is pending.
\* It flushes events, but does not seal the active round (Recorder.Flush).
Unload ==
    /\ Reload /\ ~s.reloaded /\ s.loaded = "on" /\ s.capturing /\ s.phase # "warmup"
    /\ s' = [s EXCEPT !.loaded = "unloading", !.reloaded = TRUE,
       !.interrupted[s.id] = IF s.capturing /\ s.ri >= 0 /\ ~s.finalized
                             THEN @ \cup {s.ri} ELSE @,
       !.q = IF s.capturing THEN Append(@, Job(s.id, s.buf, s.partial, FALSE)) ELSE @,
       !.buf = {}, !.capturing = FALSE, !.ri = -1, !.endPending = FALSE]
Load ==
    /\ s.loaded = "unloading" /\ s.worker = "idle" /\ s.q = <<>>
    /\ LET g == s.scanGen + 1
       IN s' = [s EXCEPT !.loaded = "scanning", !.scanGen = g,
          !.workerGen = g, !.requestEpoch = s.epoch, !.workerEpoch = s.epoch,
          !.response = EmptyFile, !.storeRows = {}, !.storePartial = {}]

\* A worker response from an older generation is discarded. A current scan
\* publishes stale in-progress files as abandoned before returning its match.
Scan ==
    /\ s.loaded = "scanning"
    /\ LET current == s.workerGen = s.scanGen
           old == s.workerEpoch
           stale == {e \in E : e # old /\ s.progress[e].exists /\ s.progress[e].rows # {}}
           f == IF current THEN s.progress[old] ELSE EmptyFile
       IN s' = [s EXCEPT
          !.loaded = IF current THEN "response" ELSE "scanning",
          !.response = IF current THEN f ELSE @,
          !.responseGen = IF current THEN s.workerGen ELSE @,
          !.responseEpoch = IF current THEN old ELSE @,
          !.final = [e \in E |-> IF current /\ e \in stale THEN s.progress[e] ELSE s.final[e]],
          !.writes = [e \in E |-> s.writes[e] +
                    (IF current /\ e \in stale THEN 1 ELSE 0)],
          !.abandoned = IF current THEN @ \cup stale ELSE @,
          !.progress = [e \in E |-> IF current /\ e \in stale THEN EmptyFile ELSE s.progress[e]],
          !.workerGen = IF current THEN @ ELSE s.scanGen,
          !.workerEpoch = IF current THEN @ ELSE s.epoch]

\* Resume accepts only the latest generation and the live match identity. A
\* rejected response triggers another scan and leaves that old file abandoned.
Resume ==
    /\ s.loaded = "response"
    /\ LET currentAnswer == s.responseGen = s.scanGen
           found == s.response.exists
           accepted == currentAnswer /\ found /\ s.responseEpoch = s.epoch
           rejected == currentAnswer /\ found /\ ~accepted
           canStart == currentAnswer /\ ~found /\ ~s.winSeen /\ s.human
                     /\ s.phase \in {"freeze", "live", "post"}
           mid == s.phase \in {"freeze", "live"}
           count == Cardinality(s.response.rows)
           prior == (IF found THEN count ELSE 0)..(s.played-1)
           nextGen == s.scanGen + 1
       IN IF ~currentAnswer THEN
              s' = [s EXCEPT !.loaded = "scanning", !.response = EmptyFile,
                 !.workerGen = s.scanGen, !.workerEpoch = s.epoch]
          ELSE IF rejected THEN
              s' = [s EXCEPT !.loaded = "scanning", !.scanGen = nextGen,
                 !.workerGen = nextGen, !.workerEpoch = s.epoch,
                 !.requestEpoch = s.epoch, !.response = EmptyFile,
                 !.rescanCount = @ + 1,
                 !.final[s.responseEpoch] = s.response,
                 !.writes[s.responseEpoch] = @ + 1,
                 !.abandoned = @ \cup {s.responseEpoch},
                 !.progress[s.responseEpoch] = EmptyFile]
          ELSE
              s' = [s EXCEPT !.loaded = "on", !.capturing = accepted \/ canStart,
                 !.id = IF accepted THEN s.epoch ELSE @,
                 !.ri = IF (accepted \/ canStart) /\ mid /\ count <= s.played THEN s.played ELSE -1,
                 !.finalized = FALSE, !.buf = prior,
                 !.partial = s.response.partial \cup prior \cup
                    (IF accepted THEN s.interrupted[s.responseEpoch] ELSE {}),
                 !.storeRows = s.response.rows, !.storePartial = s.response.partial,
                 !.endPending = IF accepted /\ s.winSeen THEN TRUE ELSE @,
                 !.startedAfterEnd = @ \/ (canStart /\ s.winSeen)]

\* One FIFO worker; tmp may be incomplete until Encode finishes. Only Move
\* publishes it.
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
        \/ EndMatch \/ MapEnd \/ Disconnect \/ Restart \/ IdentityDrift \/ Unload \/ Load \/ Scan \/ Resume \/ Worker
Spec == Init /\ [][Next]_vars /\ WF_vars(Worker) /\ WF_vars(EndMatch)
        /\ WF_vars(Load) /\ WF_vars(Scan) /\ WF_vars(Resume)

TypeOK == /\ s.epoch \in E /\ s.played \in 0..Rounds
          /\ s.ri \in {-1} \cup R
          /\ \A e \in E : s.final[e]["rows"] \subseteq R /\ s.progress[e]["rows"] \subseteq R
CompletedExactlyOnce == \A e \in E : s.final[e].exists => s.expected[e] \subseteq s.final[e].rows
ReloadAccounted == \A e \in E : s.final[e].exists =>
    (s.expected[e] \subseteq s.final[e].rows /\
     (s.interrupted[e] \cap s.final[e].rows) \subseteq s.final[e].partial)
Parseable == \A e \in E : s.progress[e].whole /\ s.final[e].whole
FinalAtMostOnce == \A e \in E : s.writes[e] <= 1
SameMatchResume == ~s.resumedWrong
RejectedResumeAbandoned == \A e \in s.abandoned : s.final[e].exists /\ ~s.progress[e].exists
NoCaptureStartAfterEnd == ~s.startedAfterEnd
NormalEventuallyFinal == \A e \in E : (e \in s.normalEnd) ~> s.final[e].exists
=============================================================================
