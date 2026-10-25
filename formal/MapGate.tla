---------------------------- MODULE MapGate ----------------------------
EXTENDS Naturals, TLC
CONSTANTS Maps, Reloads, Hot, AtMatch, OrderedEnd, AccurateName, EndThrows, ReloadDuringEnd
VARIABLE s
vars == <<s>>
Init == s = [live |-> AtMatch, named |-> AtMatch, ready |-> AtMatch,
  map |-> IF AtMatch THEN 1 ELSE 0, reloads |-> 0,
  gate |-> FALSE, awaiting |-> Hot, needInit |-> TRUE,
  capturing |-> FALSE, roundLive |-> FALSE, pendingStart |-> FALSE,
  ending |-> FALSE, scan |-> FALSE, badAccess |-> FALSE]
EngineStart ==
 /\ ~s.live /\ s.map < Maps /\ ~s.ending
 /\ s' = [s EXCEPT !.live = TRUE, !.named = TRUE, !.ready = FALSE,
                   !.map = @+1, !.pendingStart = TRUE]
EntityReady == /\ s.live /\ ~s.ready /\ s' = [s EXCEPT !.ready = TRUE]
MapStart ==
 /\ s.pendingStart /\ s.live /\ ~s.ending
 /\ s' = [s EXCEPT !.gate = TRUE, !.awaiting = FALSE, !.needInit = TRUE,
                   !.capturing = FALSE, !.roundLive = FALSE, !.pendingStart = FALSE]
\* Callbacks are serialized. OnMapEnd normally completes before server teardown.
MapEnd ==
 /\ s.live /\ ~s.ending /\ ~s.pendingStart
 /\ s' = [s EXCEPT !.gate = FALSE, !.awaiting = FALSE, !.ending = TRUE,
                   !.needInit = IF EndThrows /\ s.capturing THEN @ ELSE TRUE,
                   !.capturing = IF EndThrows THEN @ ELSE FALSE,
                   !.roundLive = IF EndThrows THEN @ ELSE FALSE,
                   !.scan = IF EndThrows /\ s.capturing THEN @ ELSE FALSE]
EngineEnd ==
 /\ s.live /\ (s.ending \/ ~OrderedEnd)
 /\ s' = [s EXCEPT !.live = FALSE, !.ready = FALSE, !.gate = FALSE, !.needInit = TRUE,
                   !.named = IF AccurateName THEN FALSE ELSE @,
                   !.ending = FALSE, !.pendingStart = FALSE]
Reload ==
 /\ s.reloads < Reloads /\ (~s.ending \/ ReloadDuringEnd)
 /\ s' = [s EXCEPT !.reloads = @+1, !.live = FALSE, !.gate = FALSE, !.awaiting = TRUE,
                   !.needInit = TRUE, !.capturing = FALSE, !.roundLive = FALSE, !.scan = FALSE]
Housekeeping ==
 /\ LET g == s.gate \/ (s.needInit /\ s.awaiting /\ s.named)
        init == s.needInit /\ g /\ s.ready /\ s.live
        probe == s.needInit /\ g /\ s.live
        steady == ~s.needInit
    IN s' = [s EXCEPT !.gate = g /\ s.live,
       !.awaiting = IF s.needInit /\ s.awaiting /\ s.named THEN FALSE ELSE @,
       !.needInit = IF init THEN FALSE ELSE @,
       !.scan = IF init THEN TRUE ELSE @,
       !.badAccess = @ \/ ((probe \/ steady) /\ ~s.live)]
ScanReply ==
 /\ s.scan
 \* OnMapStart without OnMapEnd leaves scan pending but nulls _rules.
 \* A scan-done message then has no rules to read; an old resume can throw
 \* before entity access. Both refine to a dropped reply for this safety model.
 /\ s' = [s EXCEPT !.scan = FALSE,
                   !.capturing = IF s.needInit THEN @ ELSE TRUE,
                   !.roundLive = IF s.needInit THEN @ ELSE TRUE,
                   !.badAccess = @ \/ (~s.needInit /\ ~s.live)]
Tick ==
 s' = [s EXCEPT !.badAccess = @ \/ (~s.needInit /\ s.capturing /\ s.roundLive /\ ~s.live)]
\* A direct map change whose new OnMapStart arrives without an old OnMapEnd.
\* The callback runs before any tick/housekeeping of the new map.
SwitchMap ==
 /\ s.live /\ ~s.ending /\ ~s.pendingStart /\ s.map < Maps
 /\ s' = [s EXCEPT !.map = @+1, !.named = TRUE, !.ready = FALSE,
       !.live = TRUE, !.gate = TRUE, !.awaiting = FALSE, !.needInit = TRUE,
       !.capturing = FALSE, !.roundLive = FALSE]
Next == EngineStart \/ EntityReady \/ MapStart \/ MapEnd \/ EngineEnd \/ Reload
        \/ Housekeeping \/ ScanReply \/ Tick \/ SwitchMap
Spec == Init /\ [][Next]_vars /\ WF_vars(Housekeeping) /\ WF_vars(EntityReady)
        /\ WF_vars(MapStart) /\ WF_vars(ScanReply) /\ WF_vars(EngineEnd)
TypeOK == s.map \in 0..Maps /\ s.reloads \in 0..Reloads
NoMenuEntities == ~s.badAccess
GateSound == s.gate => s.live
InitializedSound == ~s.needInit => s.live
EventuallyOpen == (<>[]s.live) => <>[]s.gate
EventuallyInit == (<>[]s.live) => <>[](~s.needInit)
=============================================================================
