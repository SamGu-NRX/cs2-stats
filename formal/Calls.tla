----------------------------- MODULE Calls -----------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC
CONSTANTS Bots, Rounds, MaxBuys, MaxCalls, Deferred, StartMoney

Teams == {"T", "CT"}
Slots == {"primary", "pistol"}
Kinds == {"primary", "pistol", "armor", "utility"}
Tokens == Bots \X (1..Rounds) \X (1..MaxBuys)
NoHandle == <<0, 0, 0>>
VARIABLE s
vars == <<s>>
Half(r) == IF r <= 1 THEN 1 ELSE 2
Team(b,r) == IF (b = 1) = (Half(r) = 1) THEN "T" ELSE "CT"
FullBuy(b,r) == IF Team(b,r) = "T" THEN 3700 ELSE 3900
Cost(b,k) == CASE k = "primary" -> IF Team(b,s.round) = "T" THEN 1800 ELSE 1950
                       [] k = "pistol" -> 300
                       [] k = "armor" -> 650
                       [] OTHER -> 300

\* The ledger stores only primary and pistol purchases. Its round number is
\* incremented and its list cleared by NewRound, matching PurchaseLedger.
Init == s = [round |-> 0, buyTime |-> FALSE, calls |-> 0,
    active |-> [t \in Teams |-> "none"], activeHalf |-> [t \in Teams |-> 0],
    pending |-> [t \in Teams |-> "none"], pendingHalf |-> [t \in Teams |-> 0],
    buyZone |-> [b \in Bots |-> TRUE],
    money |-> [b \in Bots |-> StartMoney], spent |-> [b \in Bots |-> 0],
    credited |-> [b \in Bots |-> 0], buys |-> [b \in Bots |-> 0],
    heldSlot |-> [b \in Bots |-> [k \in Slots |-> NoHandle]],
    entryExists |-> [t \in Tokens |-> FALSE], entryRound |-> [t \in Tokens |-> 0],
    entrySlot |-> [t \in Tokens |-> "primary"], entryPaid |-> [t \in Tokens |-> 0],
    held |-> [t \in Tokens |-> FALSE], lost |-> [t \in Tokens |-> FALSE],
    refundCounts |-> [t \in Tokens |-> 0], callbacks |-> <<>>,
    ledgerRound |-> 0, oldCallbackCredit |-> 0,
    cleanReset |-> TRUE, correctHalf |-> TRUE]

Saving(b) == s.active[Team(b,s.round)] = "save" /\
              s.money[b] + 1400 < FullBuy(b,s.round)
CurrentEntry(b,t) == s.entryExists[t] /\ s.entryRound[t] = s.ledgerRound /\ t[1] = b

\* A chat-wheel call applies now during buy time, or stores one call for the
\* next round after buy time. Save refunds are represented by SaveRefund.
Call(t,c) ==
    /\ t \in Teams /\ s.calls < MaxCalls
    /\ s' = [s EXCEPT !.calls = @ + 1,
       !.active[t] = IF s.buyTime THEN c ELSE @,
       !.activeHalf[t] = IF s.buyTime THEN Half(s.round) ELSE @,
       !.pending[t] = IF ~s.buyTime THEN c ELSE @,
       !.pendingHalf[t] = IF ~s.buyTime THEN Half(s.round) ELSE @,
       !.cleanReset = @ /\ TRUE]

SavingAfter(b,price) == s.active[Team(b,s.round)] = "save" /\
    s.money[b] - price + 1400 < FullBuy(b,s.round)

\* A gun purchase records an entity handle and price. Plugin purchases are
\* blocked by IsSaving and skipped outside the buy zone. Native purchases may
\* still arrive and schedule a deferred, handle-specific refund.
Purchase(b,k,source) ==
    /\ s.buyTime /\ b \in Bots /\ s.buys[b] < MaxBuys
    /\ k \in Kinds
    /\ source \in {"plugin", "native"}
    /\ (source = "native" \/ ~Saving(b))
    /\ (source = "native" \/ s.buyZone[b])
    /\ s.money[b] >= Cost(b,k)
    /\ LET n == s.buys[b] + 1
           token == <<b, s.round, n>>
           gun == k \in Slots
           old == s.heldSlot[b][IF gun THEN k ELSE "primary"]
           queues == source = "native" /\ gun /\ SavingAfter(b, Cost(b,k))
       IN s' = [s EXCEPT
          !.money[b] = @ - Cost(b,k), !.spent[b] = @ + Cost(b,k), !.buys[b] = @ + 1,
          !.held = IF gun /\ old # NoHandle THEN [@ EXCEPT ![old] = FALSE] ELSE @,
          !.lost = IF gun /\ old # NoHandle THEN [@ EXCEPT ![old] = TRUE] ELSE @,
          !.held[token] = IF gun THEN TRUE ELSE @,
          !.heldSlot[b][IF gun THEN k ELSE "primary"] = IF gun THEN token ELSE @,
          !.entryExists[token] = IF gun THEN TRUE ELSE @,
          !.entryRound[token] = IF gun THEN s.ledgerRound ELSE @,
          !.entrySlot[token] = IF gun THEN k ELSE @,
          !.entryPaid[token] = IF gun THEN Cost(b,k) ELSE @,
          !.callbacks = IF queues THEN Append(@, [token |-> token, round |-> s.ledgerRound]) ELSE @]

\* Save refunds only current-round ledger entries whose exact handles remain
\* held. Undo removes the ledger entry even when the handle was dropped, gifted,
\* or replaced, but credits money only when removeIfHeld succeeds.
SaveRefund ==
    /\ s.buyTime
    /\ \E t \in Tokens :
          LET b == t[1]
              heldNow == s.held[t]
          IN /\ CurrentEntry(b,t)
             /\ Saving(b)
             /\ s' = [s EXCEPT
                  !.entryExists[t] = FALSE,
                  !.held[t] = FALSE,
                  !.heldSlot[b][s.entrySlot[t]] = IF @ = t THEN NoHandle ELSE @,
                  !.money[b] = IF heldNow THEN @ + s.entryPaid[t] ELSE @,
                  !.credited[b] = IF heldNow THEN @ + s.entryPaid[t] ELSE @,
                  !.refundCounts[t] = IF heldNow THEN @ + 1 ELSE @]

\* Deferred RefundGuns carries the PurchaseLedger round and handle. A callback
\* from an earlier round credits nothing, even if the handle is reused.
Callback ==
    /\ Len(s.callbacks) > 0
    /\ LET cb == Head(s.callbacks)
           t == cb.token
           current == cb.round = s.ledgerRound
           valid == current /\ s.entryExists[t] /\ s.entryRound[t] = s.ledgerRound
           heldNow == valid /\ s.held[t]
           oldHeld == ~current /\ s.entryExists[t] /\ s.held[t]
           b == t[1]
       IN s' = [s EXCEPT !.callbacks = Tail(@),
          !.oldCallbackCredit = IF oldHeld THEN @ + s.entryPaid[t] ELSE @,
          !.entryExists[t] = IF valid THEN FALSE ELSE @,
          !.held[t] = IF valid THEN FALSE ELSE @,
          !.heldSlot[b][IF valid THEN s.entrySlot[t] ELSE "primary"] =
              IF valid /\ @ = t THEN NoHandle ELSE @,
          !.money[b] = IF heldNow THEN @ + s.entryPaid[t] ELSE @,
          !.credited[b] = IF heldNow THEN @ + s.entryPaid[t] ELSE @,
          !.refundCounts[t] = IF heldNow THEN @ + 1 ELSE @]

\* External engine changes used to test the handle guard. They do not change
\* the ledger, only whether the recorded entity is still held.
LoseHandle ==
    /\ \E t \in Tokens : s.entryExists[t] /\ s.held[t]
    /\ LET t == CHOOSE x \in Tokens : s.entryExists[x] /\ s.held[x]
           b == t[1]
       IN s' = [s EXCEPT !.held[t] = FALSE, !.lost[t] = TRUE,
          !.heldSlot[b][s.entrySlot[t]] = IF @ = t THEN NoHandle ELSE @]

EndBuy == /\ s.buyTime /\ s' = [s EXCEPT !.buyTime = FALSE]

\* NewRound increments the ledger round, clears its list, clears active calls,
\* and drops pending calls at halftime. Deferred callbacks intentionally remain
\* in the queue so their round guard is checked later.
RoundStart ==
    /\ ~s.buyTime /\ s.round < Rounds
    /\ LET r == s.round + 1
           halfChange == Half(r) # Half(s.round)
       IN s' = [s EXCEPT !.round = r, !.buyTime = TRUE,
          !.ledgerRound = @ + 1, !.active = [t \in Teams |-> "none"],
          !.activeHalf = [t \in Teams |-> 0],
          !.pending = [t \in Teams |-> IF halfChange THEN "none" ELSE s.pending[t]],
          !.pendingHalf = [t \in Teams |-> IF halfChange THEN 0 ELSE s.pendingHalf[t]],
          !.money = [b \in Bots |-> StartMoney], !.spent = [b \in Bots |-> 0],
          !.credited = [b \in Bots |-> 0], !.buys = [b \in Bots |-> 0],
          !.heldSlot = [b \in Bots |-> [k \in Slots |-> s.heldSlot[b][k]]],
          !.entryExists = [t \in Tokens |-> FALSE], !.held = [t \in Tokens |-> s.held[t]],
          !.cleanReset = TRUE,
          !.correctHalf = @ /\ \A t \in Teams :
             s.pending[t] = "none" \/ halfChange \/ s.pendingHalf[t] = Half(r)]
ApplyPending ==
    /\ s.buyTime
    /\ \E t \in Teams : s.pending[t] # "none" /\ s.pendingHalf[t] = Half(s.round)
    /\ LET t == CHOOSE x \in Teams : s.pending[x] # "none" /\ s.pendingHalf[x] = Half(s.round)
       IN s' = [s EXCEPT !.active[t] = s.pending[t], !.activeHalf[t] = Half(s.round),
          !.pending[t] = "none", !.pendingHalf[t] = 0]

Next == (\E t \in Teams, c \in {"save", "buy"} : Call(t,c))
        \/ (\E b \in Bots, k \in Kinds, source \in {"plugin","native"} : Purchase(b,k,source))
        \/ SaveRefund \/ Callback \/ LoseHandle \/ EndBuy \/ RoundStart \/ ApplyPending
Spec == Init /\ [][Next]_vars

TypeOK == /\ s.round \in 0..Rounds /\ s.ledgerRound \in 0..Rounds
          /\ \A b \in Bots : s.money[b] >= 0 /\ s.buys[b] <= MaxBuys
NoDoubleRefund == \A t \in Tokens : s.refundCounts[t] <= 1
NoMoneyCreated == \A b \in Bots : s.credited[b] <= s.spent[b]
PendingCorrectHalf == \A t \in Teams : s.active[t] = "none" \/ s.activeHalf[t] = Half(s.round)
RoundStateReset == \A t \in Tokens : s.entryExists[t] => s.entryRound[t] = s.ledgerRound
GiftedDroppedReplacedSafe == \A t \in Tokens : s.lost[t] => s.refundCounts[t] = 0
OldCallbackSafe == s.oldCallbackCredit = 0
RichKeepsPurchases ==
    \A t \in Tokens :
        s.entryExists[t] /\
        s.money[t[1]] + 1400 >= FullBuy(t[1], s.round)
        => s.refundCounts[t] = 0
=============================================================================
