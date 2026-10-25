---------------------------- MODULE Publish ----------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC
CONSTANTS Writers, Pruners, Initial, Reader, Retry, Failures, Crashes,
          Retirement, ManualDelete, PruneLimit, Fixed, StaleActor
W == 1..Writers
V == 0..Writers
P == 1..Pruners
\* The writer-supplied catalog for this abstraction; it is not the schema's full required catalog.
Tables == {"match", "other"}
\* "match" also abstracts the rating layout's required player_rounds table;
\* "other" can be damages.parquet, which is not checked by demo_layout.
Files == Tables \cup {"COMPLETE"}
Protected == {"stale: reason", "unreadable", "unknown"}
VARIABLE s
vars == <<s>>
Own(a) == ~Fixed \/ s.owner = a
PruneOwner(p) == Writers + p
OwnP(p) == ~Fixed \/ s.owner = PruneOwner(p)
Free == ~Fixed \/ s.owner = 0
Good(v) == IF v \in V THEN
    s.loc[v] = "version" /\ "COMPLETE" \in s.files[v]
    /\ "match" \in s.manifest[v] /\ s.manifest[v] \subseteq s.files[v]
    ELSE FALSE
Resolves == s.marker = "none" /\ Good(s.current)
Available == ~s.exists \/ s.marker # "none" \/ Good(s.current)
Entries == {<<v, s.loc[v]>> : v \in {i \in V : s.loc[i] # "none"}}
           \cup {<<w, "pointer">> : w \in s.staged}
           \cup (IF s.current # -1 THEN {<<-1,"CURRENT">>} ELSE {})
Init ==
  s = [loc |-> [v \in V |-> IF (v = 0 /\ Initial # "fresh") \/ (Initial = "garbage" /\ v = 1)
                              THEN "version" ELSE "none"],
       files |-> [v \in V |-> IF (v = 0 /\ Initial # "fresh") \/ (Initial = "garbage" /\ v = 1)
                                THEN Files ELSE {}],
       manifest |-> [v \in V |-> Tables],
       pc |-> [w \in W |-> IF Initial = "garbage" THEN 11 ELSE 0],
       staged |-> {}, current |-> IF Initial = "fresh" THEN -1
                                  ELSE IF Initial = "garbage" THEN 1 ELSE 0,
       marker |-> IF Initial \in {"live","fresh","garbage"} THEN "none" ELSE Initial,
       exists |-> Initial # "fresh", external |-> Initial \in {"replaced","empty"},
       withdrawn |-> IF Initial \in {"live","fresh","garbage"} THEN {} ELSE {0},
       everWithdrawn |-> Initial \notin {"live","fresh","garbage"},
       ppc |-> [p \in P |-> "idle"], cached |-> [p \in P |-> -1],
       owner |-> 0, stalePC |-> 0,
       retiredBranch |-> [p \in P |-> FALSE], pending |-> [p \in P |-> {}],
       lockedPass |-> [p \in P |-> FALSE], passes |-> [p \in P |-> 0],
       locks |-> IF Initial = "garbage" THEN {<<0,"match">>} ELSE {},
       rpc |-> IF Reader = "none" THEN "done" ELSE "marker",
       chosen |-> -1, target |-> -1, loaded |-> <<>>, checked |-> {}, attempt |-> 1,
       badIncomplete |-> FALSE, badValidation |-> FALSE, badBinding |-> FALSE, readerError |-> FALSE, returned |-> FALSE,
       deletedStale |-> FALSE, retired |-> FALSE, manual |-> FALSE,
       crashed |-> FALSE]
Start(w) ==
  /\ s.pc[w] = 0 /\ Free
  /\ (IF Retry /\ w # 1 THEN s.pc[w-1] \in {-1,11} ELSE TRUE)
  /\ s' = [s EXCEPT !.loc[w] = "tmp", !.files[w] = {}, !.pc[w] = 1,
       !.exists = TRUE, !.owner = IF Fixed THEN w ELSE @]
Write(w,t,n) ==
  /\ s.pc[w] = n /\ s.loc[w] = "tmp" /\ Own(w)
  /\ s' = [s EXCEPT !.files[w] = @ \cup {t}, !.pc[w] = n+1]
Validate(w) ==
  /\ s.pc[w] = 3 /\ Own(w)
  /\ s' = [s EXCEPT !.pc[w] = IF Tables \subseteq s.files[w] /\ s.loc[w] = "tmp"
                              THEN 4 ELSE -1]
Listing(w) ==
  /\ s.pc[w] = 4 /\ Own(w)
  /\ s' = [s EXCEPT !.manifest[w] = IF Fixed THEN Tables ELSE s.files[w] \cap Tables, !.pc[w] = 5]
Complete(w) ==
  /\ s.pc[w] = 5 /\ s.loc[w] = "tmp" /\ Own(w)
  /\ s' = [s EXCEPT !.files[w] = @ \cup {"COMPLETE"}, !.pc[w] = 6]
Rename(w) ==
  /\ s.pc[w] = 6 /\ s.loc[w] = "tmp" /\ Own(w)
  /\ s' = [s EXCEPT !.loc[w] = "version", !.pc[w] = 7]
Stage(w) ==
  /\ s.pc[w] = 7 /\ Own(w)
  /\ s' = [s EXCEPT !.staged = @ \cup {w}, !.pc[w] = 8]
Replace(w) ==
  /\ s.pc[w] = 8 /\ w \in s.staged /\ Own(w)
  /\ s' = [s EXCEPT !.current = w, !.staged = @ \ {w}, !.pc[w] = 9]
Unretire(w) ==
  /\ s.pc[w] = 9 /\ Own(w)
  /\ s' = [s EXCEPT !.marker = "none", !.pc[w] = 10]
WriterDone(w) == /\ s.pc[w] = 10 /\ Own(w)
  /\ s' = [s EXCEPT !.pc[w] = 11, !.owner = 0]
Writer(w) == Start(w) \/ Write(w,"match",1) \/ Write(w,"other",2)
             \/ Validate(w) \/ Listing(w) \/ Complete(w) \/ Rename(w)
             \/ Stage(w) \/ Replace(w) \/ Unretire(w) \/ WriterDone(w)
Failure(w) == /\ Failures /\ s.pc[w] \in 1..9 /\ Own(w)
              /\ s' = [s EXCEPT !.pc[w] = -1, !.owner = 0]
PruneStart(p) ==
  /\ s.ppc[p] = "idle" /\ Free /\ (PruneLimit = 0 \/ s.passes[p] < PruneLimit)
  /\ s' = [s EXCEPT !.ppc[p] = "branch", !.owner = IF Fixed THEN PruneOwner(p) ELSE @,
                    !.passes[p] = IF PruneLimit = 0 THEN 0 ELSE @+1,
                    !.lockedPass[p] = FALSE]
PruneBranch(p) ==
  /\ s.ppc[p] = "branch" /\ OwnP(p)
  /\ s' = [s EXCEPT !.ppc[p] = IF s.marker \in Protected THEN "idle"
                              ELSE IF s.marker # "none" THEN "list" ELSE "cache",
                    !.retiredBranch[p] = s.marker # "none"]
PruneCache(p) ==
  /\ s.ppc[p] = "cache" /\ OwnP(p)
  /\ s' = [s EXCEPT !.cached[p] = IF Resolves THEN s.current ELSE -1,
                    !.ppc[p] = IF s.current # -1 /\ ~Resolves THEN "idle" ELSE "list"]
PruneList(p) ==
  /\ s.ppc[p] = "list" /\ OwnP(p)
  /\ s' = [s EXCEPT !.pending[p] =
       IF s.retiredBranch[p] THEN Entries
       ELSE {e \in Entries : e # <<s.cached[p],"version">> /\ e[2] # "CURRENT"},
       !.ppc[p] = "delete"]
\* rmtree is NOT atomic: handles protect individual files, not the folder.
DeleteFile(p,e,f) ==
  /\ s.ppc[p] = "delete" /\ OwnP(p) /\ e \in s.pending[p] /\ e[1] \in V
  /\ e[2] \in {"version","tmp"} /\ s.loc[e[1]] = e[2]
  /\ f \in s.files[e[1]] /\ <<e[1],f>> \notin s.locks
  /\ s' = [s EXCEPT !.files[e[1]] = @ \ {f},
       !.deletedStale = @ \/ (s.marker \in Protected /\ ~s.external
            /\ ~(s.current \in W /\ Good(s.current)))]
DeleteEntry(p,e) ==
  /\ s.ppc[p] = "delete" /\ OwnP(p) /\ e \in s.pending[p]
  /\ IF e[2] \in {"version","tmp"} THEN
       /\ (s.loc[e[1]] # e[2] \/ s.files[e[1]] = {}
            \/ \A f \in s.files[e[1]] : <<e[1],f>> \in s.locks)
       /\ s' = [s EXCEPT !.pending[p] = @ \ {e},
          !.loc[e[1]] = IF s.loc[e[1]] = e[2] /\ s.files[e[1]] = {} THEN "none" ELSE @,
          !.lockedPass[p] = @ \/ (s.loc[e[1]] = e[2] /\ s.files[e[1]] # {})]
     ELSE
       s' = [s EXCEPT !.pending[p] = @ \ {e},
          !.staged = IF e[2] = "pointer" THEN @ \ {e[1]} ELSE @,
          !.current = IF e[2] = "CURRENT" THEN -1 ELSE @]
PruneFinish(p) ==
  /\ s.ppc[p] = "delete" /\ OwnP(p) /\ s.pending[p] = {}
  /\ s' = [s EXCEPT !.ppc[p] = IF s.retiredBranch[p] /\ ~s.lockedPass[p]
                              THEN "unlink" ELSE "idle",
                    !.owner = IF s.retiredBranch[p] /\ ~s.lockedPass[p] THEN @ ELSE 0]
PruneUnlink(p) ==
  /\ s.ppc[p] = "unlink" /\ OwnP(p)
  /\ s' = [s EXCEPT !.marker = "none", !.ppc[p] = "rmdir"]
PruneRmdir(p) ==
  /\ s.ppc[p] = "rmdir" /\ OwnP(p)
  /\ s' = [s EXCEPT !.exists = IF \A v \in V : s.loc[v] = "none"
                              THEN FALSE ELSE @, !.ppc[p] = "idle", !.owner = 0]
Prune(p) == PruneStart(p) \/ PruneBranch(p) \/ PruneCache(p) \/ PruneList(p)
            \/ (\E e \in s.pending[p] : DeleteEntry(p,e)
                 \/ (\E f \in Files : DeleteFile(p,e,f)))
            \/ PruneFinish(p) \/ PruneUnlink(p) \/ PruneRmdir(p)
Retire ==
  /\ Retirement /\ ~s.retired /\ Free
  /\ s' = [s EXCEPT !.marker = "replaced", !.external = TRUE,
       !.owner = IF Fixed THEN Writers+Pruners+1 ELSE @,
       !.withdrawn = @ \cup {v \in V : s.loc[v] # "none"},
       !.everWithdrawn = TRUE, !.retired = TRUE]
RetireDone == /\ Fixed /\ s.owner = Writers+Pruners+1
  /\ s' = [s EXCEPT !.owner = 0]
StaleStart == /\ StaleActor /\ s.stalePC = 0 /\ Free
  /\ s' = [s EXCEPT !.stalePC = 1, !.owner = IF Fixed THEN Writers+Pruners+2 ELSE @]
MarkStale == /\ s.stalePC = 1 /\ Own(Writers+Pruners+2)
  /\ s' = [s EXCEPT !.marker = "stale: concurrent", !.stalePC = 2,
       !.owner = 0, !.everWithdrawn = TRUE]
Manual ==
  /\ ManualDelete /\ ~s.manual /\ s.current \in V
  /\ s' = [s EXCEPT !.files[s.current] = {}, !.loc[s.current] = "none", !.manual = TRUE]
ReadMarker ==
  /\ s.rpc = "marker"
  /\ s' = [s EXCEPT !.rpc = IF s.marker = "none" THEN "pointer" ELSE "error",
                    !.readerError = @ \/ s.marker # "none"]
ReadPointer ==
  /\ s.rpc = "pointer"
  /\ s' = [s EXCEPT !.chosen = s.current, !.rpc = "validate"]
ReadValidate ==
  /\ s.rpc = "validate"
  /\ s' = [s EXCEPT !.rpc = IF Good(s.chosen) THEN "stat" ELSE "error",
       !.readerError = @ \/ ~Good(s.chosen),
       !.badValidation = @ \/ ~Good(s.chosen),
       !.badIncomplete = @ \/ (IF Good(s.chosen) THEN s.manifest[s.chosen] # Tables ELSE FALSE)]
ReadStat ==
  /\ s.rpc = "stat" /\ Cardinality(s.checked) < Cardinality(Tables)
  /\ LET t == IF Cardinality(s.checked)=0 THEN "match" ELSE "other"
         ok == IF s.chosen \in V THEN t \in s.files[s.chosen] ELSE FALSE
     IN s' = [s EXCEPT !.checked = IF ok THEN s.checked \cup {t} ELSE s.checked,
          !.readerError = @ \/ ~ok,
          !.rpc = IF ~ok THEN "error" ELSE IF Cardinality(s.checked) = Cardinality(Tables)-1 THEN
                    IF Reader = "rating" THEN "target" ELSE "open" ELSE @]
ReadTarget ==
  /\ s.rpc = "target"
  /\ s' = [s EXCEPT !.target = s.current, !.rpc = "open"]
ReadOpen ==
  /\ s.rpc = "open" /\ Len(s.loaded) < 2
  /\ LET t == IF Len(s.loaded) = 0 THEN "match" ELSE "other"
         ok == IF s.chosen \in V THEN t \in s.files[s.chosen] ELSE FALSE
     IN s' = [s EXCEPT
       !.loaded = IF ok THEN Append(@,s.chosen) ELSE @,
       !.locks = IF ok THEN @ \cup {<<s.chosen,t>>} ELSE @,
       !.rpc = IF ~ok THEN "missing" ELSE IF Len(s.loaded) = 1 THEN "finish" ELSE "open"]
ReadFinish ==
  /\ s.rpc = "finish"
  /\ s' = [s EXCEPT !.rpc = IF Reader = "rating" /\ s.target # s.current
                             THEN "missing" ELSE "done",
       !.returned = ~(Reader = "rating" /\ s.target # s.current),
       !.badBinding = @ \/ (Reader = "rating" /\ s.target = s.current /\ s.chosen # s.target)]
ReadMissing ==
  /\ s.rpc = "missing"
  /\ LET retry == Reader \in {"python","node","node-per-file","rating"} /\ s.attempt = 1
     IN s' = [s EXCEPT !.rpc = IF retry THEN "marker" ELSE "error",
       !.attempt = IF retry THEN 2 ELSE @,
       !.checked = {}, !.chosen = -1, !.target = -1, !.loaded = <<>>, !.locks = {},
       !.returned = FALSE,
       !.readerError = @ \/ ~retry]
Unlock == /\ s.locks # {} /\ s' = [s EXCEPT !.locks = {}]
Read == ReadMarker \/ ReadPointer \/ ReadValidate \/ ReadStat \/ ReadTarget \/ ReadOpen
         \/ ReadFinish \/ ReadMissing
Crash == /\ Crashes /\ ~s.crashed /\ s' = [s EXCEPT !.crashed = TRUE]
Next == (/\ ~s.crashed
         /\ ((\E w \in W : Writer(w) \/ Failure(w)) \/ (\E p \in P : Prune(p))
              \/ Retire \/ RetireDone \/ StaleStart \/ MarkStale \/ Manual \/ Read \/ Unlock)) \/ Crash
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Read) /\ WF_vars(Unlock) /\ (\A p \in P : WF_vars(Prune(p)))
TypeOK == /\ s.current \in {-1} \cup V /\ s.staged \subseteq W
          /\ \A v \in V : s.files[v] \subseteq Files
NoMix == s.returned => Cardinality({s.loaded[i] : i \in 1..Len(s.loaded)}) <= 1
NoIncomplete == ~s.badIncomplete
ValidationSnapshot == ~s.badIncomplete
RatingBindsTarget == ~s.badBinding
NoResurrection == Resolves => s.current \notin s.withdrawn
StrictWithdrawal == s.everWithdrawn => ~Resolves
StaleKept == ~s.deletedStale
CrashAvailable == s.crashed => Available
CurrentValid == s.current = -1 \/ s.marker # "none" \/ Good(s.current)
LockDiscipline == Fixed => s.owner = 0 \/ s.owner \in W \cup {Writers+p : p \in 1..Pruners} \cup {Writers+Pruners+1, Writers+Pruners+2}
ReaderSucceeds == ~s.readerError
ReaderEventuallyReturns == <> (s.rpc \in {"done", "error"})
OldEventuallyPruned == (s.current # 0 /\ s.marker = "none" /\ s.locks = {})
                       ~> (s.loc[0] = "none")
=============================================================================
