---------------------------- MODULE Plugin ----------------------------
EXTENDS Naturals, TLC
CONSTANTS Maps, Captures, Rounds, OrderedRounds, Reloads, MidRound
VARIABLE s
vars == <<s>>
Init == s = [map |-> 0, liveMap |-> FALSE, attached |-> FALSE,
  probe |-> FALSE, failed |-> FALSE, failedMap |-> 0,
  capture |-> 0, capturing |-> FALSE, round |-> 0, reloads |-> 0,
  phase |-> "none", active |-> FALSE, live |-> FALSE, finalized |-> FALSE,
  visible |-> FALSE, reported |-> FALSE, errorRecorded |-> FALSE,
  badTrace |-> FALSE, badEnable |-> FALSE, badDoubleSeal |-> FALSE,
  seals |-> 0, sources |-> {}, win |-> FALSE, startedAfterWin |-> FALSE]
NewMap ==
 /\ ~s.liveMap /\ s.map < Maps
 /\ s' = [s EXCEPT !.map = @+1, !.liveMap = TRUE, !.attached = FALSE,
                   !.capturing = FALSE, !.active = FALSE, !.live = FALSE,
                   !.phase = "none", !.win = FALSE]
Attach(ok) ==
 /\ s.liveMap /\ ~s.attached
 /\ s' = [s EXCEPT !.attached = TRUE, !.probe = ok, !.failed = ~ok,
                   !.failedMap = IF ok THEN @ ELSE s.map, !.visible = FALSE,
                   !.reported = ~ok]
StartCapture ==
 /\ s.liveMap /\ s.attached /\ ~s.capturing /\ s.capture < Captures
 /\ s' = [s EXCEPT !.capture = @+1, !.capturing = TRUE, !.round = 0,
       !.active = FALSE, !.live = FALSE, !.finalized = FALSE, !.phase = "none",
       !.visible = FALSE, !.reported = FALSE, !.errorRecorded = FALSE,
       !.sources = {}, !.seals = 0, !.startedAfterWin = @ \/ s.win]
Begin ==
 /\ s.capturing /\ s.round < Rounds /\ s.phase \in {"none","sealed"}
 /\ s' = [s EXCEPT !.round = @+1, !.phase = "freeze", !.active = TRUE,
                   !.live = FALSE, !.finalized = FALSE, !.visible = FALSE, !.seals = 0]
BeginMidRound ==
 /\ MidRound /\ s.capturing /\ s.round < Rounds /\ s.phase = "none"
 /\ s' = [s EXCEPT !.round = @+1, !.phase = "live", !.active = TRUE,
                   !.live = TRUE, !.finalized = FALSE, !.visible = FALSE, !.seals = 0]
HotReload ==
 /\ s.liveMap /\ s.reloads < Reloads
 /\ s' = [s EXCEPT !.reloads = @+1, !.attached = FALSE, !.capturing = FALSE,
                   !.active = FALSE, !.live = FALSE, !.visible = FALSE, !.phase = "none"]
FreezeEnd ==
 /\ s.active /\ (~OrderedRounds \/ s.phase = "freeze")
 /\ s' = [s EXCEPT !.live = TRUE, !.phase = "live",
       !.sources = @ \cup {IF s.probe /\ ~s.failed THEN "los" ELSE "mask"},
       !.errorRecorded = @ \/ s.failed]
Trace(result) ==
 /\ s.capturing /\ s.live /\ s.probe /\ ~s.failed
 /\ s' = [s EXCEPT !.badTrace = @ \/ ~s.liveMap,
       !.failed = result = "failure", !.failedMap = IF result = "failure" THEN s.map ELSE @,
       !.visible = result = "clear",
       !.reported = IF result = "failure" THEN TRUE ELSE @,
       !.errorRecorded = @ \/ result = "failure",
       !.sources = @ \cup {IF result = "failure" THEN "mask" ELSE "los"}]
\* Warm-up's known-clear test may fail outside a round or capture.
Disable ==
 /\ s.liveMap /\ s.attached /\ ~s.failed
 /\ s' = [s EXCEPT !.failed = TRUE, !.failedMap = s.map, !.reported = TRUE,
       !.visible = IF s.capturing /\ s.active /\ s.live THEN FALSE ELSE @,
       !.errorRecorded = @ \/ s.capturing,
       !.sources = IF s.capturing THEN @ \cup {"mask"} ELSE @]
RoundEnd ==
 /\ s.active /\ ~s.finalized /\ (~OrderedRounds \/ s.phase = "live")
 /\ s' = [s EXCEPT !.live = FALSE, !.visible = FALSE, !.phase = "post"]
Finalize ==
 /\ s.active /\ ~s.finalized /\ (~OrderedRounds \/ s.phase = "post")
 /\ s' = [s EXCEPT !.finalized = TRUE, !.live = FALSE, !.visible = FALSE,
       !.phase = "sealed", !.seals = @+1, !.badDoubleSeal = @ \/ s.seals > 0]
Win == /\ s.capturing /\ ~s.win /\ s' = [s EXCEPT !.win = TRUE]
EndCapture ==
 /\ s.capturing
 /\ s' = [s EXCEPT !.capturing = FALSE, !.active = FALSE, !.live = FALSE,
       !.visible = FALSE, !.phase = "none",
       !.seals = IF s.active /\ ~s.finalized THEN @+1 ELSE @,
       !.badDoubleSeal = @ \/ (s.active /\ ~s.finalized /\ s.seals > 0)]
MapEnd ==
 /\ s.liveMap
 /\ s' = [s EXCEPT !.liveMap = FALSE, !.capturing = FALSE,
                   !.active = FALSE, !.live = FALSE, !.visible = FALSE, !.phase = "none"]
Next == NewMap \/ Attach(TRUE) \/ Attach(FALSE) \/ StartCapture \/ Begin \/ BeginMidRound \/ HotReload
 \/ FreezeEnd \/ Trace("clear") \/ Trace("blocked") \/ Trace("failure")
 \/ Disable \/ RoundEnd \/ Finalize \/ Win \/ EndCapture \/ MapEnd
Spec == Init /\ [][Next]_vars
TypeOK == s.map \in 0..Maps /\ s.capture \in 0..Captures /\ s.round \in 0..Rounds
NoMenuTrace == ~s.badTrace
FailureSticky == s.failedMap = s.map /\ s.failedMap # 0 => s.failed
NoVisibleWhenOff == s.failed => ~s.visible
FailureRecorded == s.live /\ s.failed => s.errorRecorded
LiveSourceRecorded == s.live => s.sources # {}
CaptureSound == s.live => s.capturing /\ s.active
NoPostFinalizeLive == s.live => ~s.finalized
NoDoubleSeal == ~s.badDoubleSeal
NoCaptureAfterWin == ~s.startedAfterWin
=============================================================================
