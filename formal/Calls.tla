----------------------------- MODULE Calls -----------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC
CONSTANTS Bots, Rounds, MaxBuys, MaxCalls, Deferred, StartMoney
\* Dollars remain exact. Two weapon slots and armor represent refund classes.
Items == {"primary", "pistol", "kevlar", "suit"}
Teams == {"T", "CT"}
Tokens == Bots \X (0..(Rounds-1)) \X (1..MaxBuys)
NoItem == [token |-> <<0,0,0>>, kind |-> "none"]
VARIABLE s
vars == <<s>>
Half(r) == IF r < 2 THEN 1 ELSE 2
Team(b,r) == IF (b = 1) = (Half(r) = 1) THEN "T" ELSE "CT"
Threshold(b,r) == IF Team(b,r) = "T" THEN 2300 ELSE 2500
Cost(b,k) == CASE k = "primary" -> IF Team(b,s.round) = "T" THEN 1050 ELSE 1250
                 [] k = "pistol" -> 300
                 [] k = "kevlar" -> 650
                 [] OTHER -> IF s.armor[b].kind # "none" THEN 350 ELSE 1000
Saving(b,call) == call = "save" /\ s.money[b] < Threshold(b,s.round)
Slot(k) == IF k \in {"kevlar","suit"} THEN "armor" ELSE k
Owned(b,k) == CASE Slot(k) = "primary" -> s.primary[b]
                  [] Slot(k) = "pistol" -> s.pistol[b]
                  [] OTHER -> s.armor[b]
First(r) == r = 0 \/ r = 2
CanRefund(b,k) == /\ Owned(b,k).kind # "none"
                  /\ (Slot(k) = "armor" \/ Owned(b,k).kind = k)
                  /\ (First(s.round) \/ k \notin s.previous[b])
                  /\ (Slot(k) # "armor" \/ ~s.previousArmor[b])
Price(b,k) == CASE k = "primary" -> IF Team(b,s.round) = "T" THEN 1050 ELSE 1250
                  [] k = "pistol" -> 300
                  [] k = "kevlar" -> 650
                  [] OTHER -> 1000
DropOne(xs,k) ==
    LET positions == {i \in 1..Len(xs) : xs[i] = k}
    IN IF positions = {} THEN xs
       ELSE LET i == CHOOSE j \in positions : \A z \in positions : j <= z
            IN SubSeq(xs,1,i-1) \o SubSeq(xs,i+1,Len(xs))
Init == s = [round |-> 0, buyTime |-> TRUE, calls |-> 0,
    active |-> [t \in Teams |-> "none"], pending |-> [t \in Teams |-> "none"],
    pendingHalf |-> [t \in Teams |-> 0],
    money |-> [b \in Bots |-> StartMoney], spent |-> [b \in Bots |-> 0],
    refunded |-> [b \in Bots |-> 0], buys |-> [b \in Bots |-> 0],
    primary |-> [b \in Bots |-> NoItem], pistol |-> [b \in Bots |-> NoItem],
    armor |-> [b \in Bots |-> NoItem], previous |-> [b \in Bots |-> {}],
    previousArmor |-> [b \in Bots |-> FALSE], tracked |-> [b \in Bots |-> <<>>],
    callbacks |-> <<>>, work |-> <<>>, bought |-> {}, refundCounts |-> [t \in Tokens |-> 0],
    keptRich |-> TRUE, correctHalf |-> TRUE, cleanReset |-> TRUE]

\* ApplyCall enumerates a snapshot of purchases per saving bot. Eligibility
\* is checked once before that bot's loop, not between its individual refunds.
SaveWork(team) ==
    IF team = "T" THEN
        IF 1 \in Bots /\ Team(1,s.round) = team /\ Saving(1,"save")
        THEN <<[bot |-> 1, items |-> s.tracked[1], richAtStart |-> FALSE]>>
        ELSE IF 2 \in Bots /\ Team(2,s.round) = team /\ Saving(2,"save")
             THEN <<[bot |-> 2, items |-> s.tracked[2], richAtStart |-> FALSE]>> ELSE <<>>
    ELSE IF 1 \in Bots /\ Team(1,s.round) = team /\ Saving(1,"save")
         THEN <<[bot |-> 1, items |-> s.tracked[1], richAtStart |-> FALSE]>>
         ELSE IF 2 \in Bots /\ Team(2,s.round) = team /\ Saving(2,"save")
              THEN <<[bot |-> 2, items |-> s.tracked[2], richAtStart |-> FALSE]>> ELSE <<>>
Call(t,c) ==
    /\ s.calls < MaxCalls /\ s.work = <<>>
    /\ s' = [s EXCEPT !.calls = @ + 1,
       !.active[t] = IF s.buyTime THEN c ELSE @,
       !.pending[t] = IF ~s.buyTime THEN c ELSE @,
       !.pendingHalf[t] = IF ~s.buyTime THEN Half(s.round) ELSE @,
       !.work = IF s.buyTime /\ c = "save" THEN SaveWork(t) ELSE @]
\* ForceBuy's weapon preference is abstracted to an allowed Buy action. Buy
\* retains its saving guard; native purchases bypass that guard.
Purchase(b,k,native) ==
    /\ s.buyTime /\ s.work = <<>> /\ s.buys[b] < MaxBuys
    /\ native \/ ~Saving(b,s.active[Team(b,s.round)])
    /\ (Slot(k) = "armor" \/ Owned(b,k).kind = "none")
    /\ (k # "kevlar" \/ s.armor[b].kind = "none")
    /\ (k # "suit" \/ s.armor[b].kind # "suit")
    /\ s.money[b] >= Cost(b,k)
    /\ LET token == <<b,s.round,s.buys[b]+1>>
           item == [token |-> token, kind |-> k]
           queueRefund == native /\ s.active[Team(b,s.round)] = "save"
                          /\ s.money[b] - Cost(b,k) < Threshold(b,s.round)
       IN s' = [s EXCEPT !.money[b] = @ - Cost(b,k), !.spent[b] = @ + Cost(b,k),
          !.buys[b] = @ + 1, !.bought = @ \cup {token},
          !.tracked[b] = Append(@,k),
          !.primary[b] = IF k = "primary" THEN item ELSE @,
          !.pistol[b] = IF k = "pistol" THEN item ELSE @,
          !.armor[b] = IF Slot(k) = "armor" THEN item ELSE @,
          !.callbacks = IF queueRefund THEN Append(@,[bot |-> b, kind |-> k, round |-> s.round]) ELSE @]

\* Refund consumes the currently owned instance, while callbacks store only
\* controller + item name. Inventory removal is assumed immediate/successful.
RefundUpdate(b,k,checkRich) ==
    LET ok == CanRefund(b,k)
        token == Owned(b,k).token
    IN [s EXCEPT
       !.money[b] = IF ok THEN @ + Price(b,k) ELSE @,
       !.refunded[b] = IF ok THEN @ + Price(b,k) ELSE @,
       !.refundCounts = IF ok THEN [@ EXCEPT ![token] = @ + 1] ELSE @,
       !.tracked[b] = IF ok THEN DropOne(@,k) ELSE @,
       !.primary[b] = IF ok /\ Slot(k) = "primary" THEN NoItem ELSE @,
       !.pistol[b] = IF ok /\ Slot(k) = "pistol" THEN NoItem ELSE @,
       !.armor[b] = IF ok /\ Slot(k) = "armor" THEN NoItem ELSE @,
       !.keptRich = @ /\ ~(ok /\ checkRich /\ s.money[b] >= Threshold(b,s.round))]
Callback ==
    /\ s.work = <<>> /\ Len(s.callbacks) > 0
    /\ LET cb == Head(s.callbacks)
           updated == RefundUpdate(cb.bot,cb.kind,TRUE)
       IN s' = [updated EXCEPT !.callbacks = Tail(s.callbacks)]
SaveRefund ==
    /\ Len(s.work) > 0
    /\ LET w == Head(s.work)
       IN IF Len(w.items) = 0
          THEN s' = [s EXCEPT !.work = Tail(@)]
          ELSE LET updated == RefundUpdate(w.bot,Head(w.items),FALSE)
               IN s' = [updated EXCEPT !.work = <<[w EXCEPT !.items = Tail(@)]>> \o Tail(s.work)]
EndBuy == /\ s.buyTime /\ s.work = <<>>
          /\ s' = [s EXCEPT !.buyTime = FALSE]
\* Round income is external, so accounting restarts at the round boundary.
\* Surviving inventory remains except at halftime. The pending calls clear
\* at the first round of the half. Deferred NextFrame closures are not cleared.
RoundStart ==
    /\ ~s.buyTime /\ s.work = <<>> /\ s.round + 1 < Rounds
    /\ Deferred \/ s.callbacks = <<>>
    /\ LET r == s.round + 1
           clear == First(r)
       IN s' = [s EXCEPT !.round = r, !.buyTime = TRUE, !.calls = 0,
          !.active = [t \in Teams |-> IF clear THEN "none" ELSE s.pending[t]],
          !.correctHalf = @ /\ \A t \in Teams :
                      clear \/ s.pending[t] = "none" \/ s.pendingHalf[t] = Half(r),
          !.pending = [t \in Teams |-> "none"], !.pendingHalf = [t \in Teams |-> 0],
          !.money = [b \in Bots |-> StartMoney], !.spent = [b \in Bots |-> 0],
          !.refunded = [b \in Bots |-> 0], !.buys = [b \in Bots |-> 0],
          !.tracked = [b \in Bots |-> <<>>],
          !.previous = [b \in Bots |-> {s.primary[b].kind,s.pistol[b].kind} \ {"none"}],
          !.previousArmor = [b \in Bots |-> ~clear /\ s.armor[b].kind # "none"],
          !.primary = IF clear THEN [b \in Bots |-> NoItem] ELSE @,
          !.pistol = IF clear THEN [b \in Bots |-> NoItem] ELSE @,
          !.armor = IF clear THEN [b \in Bots |-> NoItem] ELSE @,
          !.cleanReset = @ /\ s.callbacks = <<>>]
Next == (\E t \in Teams, c \in {"save","buy"} : Call(t,c))
        \/ (\E b \in Bots, k \in Items, native \in BOOLEAN : Purchase(b,k,native))
        \/ Callback \/ SaveRefund \/ EndBuy \/ RoundStart
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.round \in 0..(Rounds-1)
          /\ \A b \in Bots : s.money[b] >= 0 /\ s.buys[b] <= MaxBuys
NoDoubleRefund == \A t \in Tokens : s.refundCounts[t] <= 1
NoMoneyCreated == \A b \in Bots : s.refunded[b] <= s.spent[b]
RichKeepsPurchases == s.keptRich
PendingCorrectHalf == s.correctHalf
RoundStateReset == s.cleanReset
=============================================================================
