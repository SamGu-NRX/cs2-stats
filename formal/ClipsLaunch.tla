---------------------------- MODULE ClipsLaunch ----------------------------
(***************************************************************************)
(* The clips launch, settle and lock protocol (app/src-tauri/src/clips/     *)
(* launch.rs and mod.rs, design/clips.md "Keeping operations apart" and     *)
(* "When a take counts") for one job with one clip.                         *)
(*                                                                         *)
(* Actors: app instances sharing clips.lock (Instances), each with its own  *)
(* process-wide mutex, launch steps, watcher threads and scans; each        *)
(* launch's HLAE and CS2 processes and the in-game director; and the user,  *)
(* who may start CS2 normally whenever no CS2 runs, replacing console.log.  *)
(* An instance can crash at any step: its mutex, OS lock and watchers go,   *)
(* the files and the game processes stay.                                   *)
(*                                                                         *)
(* Abstractions: the launch nonce is the launch number (a line carries the  *)
(* nonce of the director that wrote it, so a log holds only its session's   *)
(* lines); console.log is [owner, ended]: the session that last replaced it *)
(* and whether that session's director wrote "END ... why=end_tick". Each   *)
(* launch makes at most one take, named by the launch (creator), and the    *)
(* app finds a take's owner as launch.rs owner() does: the highest-numbered *)
(* launch whose record does not list the take. Publishing a file is one     *)
(* atomic step (rename_no_replace). One guarded operation runs at a time    *)
(* per instance (the mutex), and across instances the OS lock admits one    *)
(* instance, so every guarded step below needs the instance to hold both.   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Instances,      \* app instances, e.g. {"A", "B"}
  N,              \* launches, numbered 1..N (sequence number = nonce)
  Crashes,        \* instance crashes allowed in a behaviour
  UserSessions,   \* normal CS2 sessions the user may start
  SpawnFails,     \* starting HLAE can fail
  PidsFail,       \* publishing pids.json can fail once HLAE runs
  WatcherCheck,   \* prepare_launch refuses while a watcher runs (832ce39); FALSE is d0345ae
  WatcherSettles, \* the watcher settles its launch before letting the lock go (d0345ae); FALSE is 44f4312
  HlaeCheck       \* proposed, not in the code: prepare_launch also refuses while any HLAE.exe runs

Launches == 1..N
Results == {"none", "ended", "stopped", "damaged", "notstarted"}
None == 0

VARIABLES
  osLock,      \* instance holding clips.lock, or "none"
  busy,        \* per instance: the guarded operation it is in, or "idle"
  running,     \* per instance: watchers still holding the OS lock
  watchers,    \* per instance: launches its watcher threads wait on
  damage,      \* launches whose pids could not be published (the watcher's damage argument)
  lpc,         \* per instance: launch step, and the launch it is making
  rec,         \* rec[n]: the launch record is published
  before,      \* before[n]: takes that existed when record n was published
  pids,        \* pids[n]: pids.json is published
  result,      \* result[n]: what result.json says, "none" while absent
  hlae,        \* hlae[n] \in {"none","running","exited"}
  cs2,         \* cs2[n] \in {"none","running","exited"}
  director,    \* director[n] \in {"idle","recording","ended","stopped"}
  takes,       \* launches whose take folder exists (a take is named by its creator)
  log,         \* console.log: [owner |-> session (0 = user), ended |-> BOOLEAN]
  userCs2,     \* a normal CS2 session runs
  crashes,     \* crashes so far
  sessions,    \* user sessions so far
  accepted     \* takes some scan or finish accepted

vars == <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result,
          hlae, cs2, director, takes, log, userCs2, crashes, sessions, accepted>>

Init ==
  /\ osLock = "none"
  /\ busy = [i \in Instances |-> "idle"]
  /\ running = [i \in Instances |-> 0]
  /\ watchers = [i \in Instances |-> {}]
  /\ damage = {}
  /\ lpc = [i \in Instances |-> [step |-> "idle", n |-> None]]
  /\ rec = [n \in Launches |-> FALSE]
  /\ before = [n \in Launches |-> {}]
  /\ pids = [n \in Launches |-> FALSE]
  /\ result = [n \in Launches |-> "none"]
  /\ hlae = [n \in Launches |-> "none"]
  /\ cs2 = [n \in Launches |-> "none"]
  /\ director = [n \in Launches |-> "idle"]
  /\ takes = {}
  /\ log = [owner |-> None, ended |-> FALSE]
  /\ userCs2 = FALSE
  /\ crashes = 0
  /\ sessions = 0
  /\ accepted = {}

\* ---------------------------------------------------------------- helpers

AnyCs2 == userCs2 \/ \E n \in Launches : cs2[n] = "running"
\* launch.rs running(): its recorded HLAE or any cs2.exe is alive; no record of HLAE is not known to run
Runs(n) == pids[n] /\ (hlae[n] = "running" \/ AnyCs2)
\* the result settle() publishes for n once its processes have exited
SettledResult(n) ==
  IF ~pids[n] THEN "damaged"
  ELSE IF log.owner = n /\ log.ended THEN "ended" ELSE "stopped"
\* settle_launches(): every pending launch whose processes have exited, in one guarded pass
SettleAll(r) == [n \in Launches |-> IF rec[n] /\ r[n] = "none" /\ ~Runs(n) THEN SettledResult(n) ELSE r[n]]
Pending(r) == {n \in Launches : rec[n] /\ r[n] = "none"}
\* launch.rs owner(): the highest launch whose record does not list take t
Owner(t) == LET c == {n \in Launches : rec[n] /\ t \notin before[n]} IN
            IF c = {} THEN None ELSE CHOOSE n \in c : \A m \in c : m <= n
\* take_proven(): the take's owner settled with its director's END at the end tick
Proven(t, r) == Owner(t) # None /\ r[Owner(t)] = "ended"
NextLaunch == CHOOSE n \in Launches : ~rec[n] /\ \A m \in Launches : m < n => rec[m]
CanGuard(i) == osLock \in {"none", i} /\ busy[i] = "idle"
Release(i) == IF running[i] = 0 THEN "none" ELSE i

\* ---------------------------------------------------------------- the app

\* clips_launch: guard, then prepare_launch settles earlier launches and refuses while one runs
LaunchBegin(i) ==
  /\ CanGuard(i) /\ lpc[i].step = "idle" /\ \E n \in Launches : ~rec[n]
  /\ LET r == SettleAll(result) IN
     IF Pending(r) # {} \/ AnyCs2 \/ (WatcherCheck /\ running[i] > 0)
        \/ (HlaeCheck /\ \E m \in Launches : hlae[m] = "running")
     THEN /\ result' = r /\ osLock' = Release(i)
          /\ UNCHANGED <<busy, lpc>>
     ELSE /\ result' = r /\ osLock' = i /\ busy' = [busy EXCEPT ![i] = "launch"]
          /\ lpc' = [lpc EXCEPT ![i] = [step |-> "record", n |-> NextLaunch]]
  /\ UNCHANGED <<running, watchers, damage, rec, before, pids, hlae, cs2, director, takes, log,
                 userCs2, crashes, sessions, accepted>>

\* publish the launch record with the takes the clip already has
LaunchRecord(i) ==
  /\ lpc[i].step = "record"
  /\ LET n == lpc[i].n IN
     /\ rec' = [rec EXCEPT ![n] = TRUE]
     /\ before' = [before EXCEPT ![n] = takes]
     /\ lpc' = [lpc EXCEPT ![i].step = "spawn"]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, pids, result, hlae, cs2, director, takes,
                 log, userCs2, crashes, sessions, accepted>>

\* start_launch: start HLAE; a failed start publishes "not started" at once and lets the guard go
LaunchSpawn(i) ==
  /\ lpc[i].step = "spawn"
  /\ LET n == lpc[i].n IN
     \/ /\ hlae' = [hlae EXCEPT ![n] = "running"]
        /\ lpc' = [lpc EXCEPT ![i].step = "pids"]
        /\ UNCHANGED <<result, osLock, busy>>
     \/ /\ SpawnFails
        /\ result' = [result EXCEPT ![n] = "notstarted"]
        /\ lpc' = [lpc EXCEPT ![i] = [step |-> "idle", n |-> None]]
        /\ busy' = [busy EXCEPT ![i] = "idle"] /\ osLock' = Release(i)
        /\ UNCHANGED hlae
  /\ UNCHANGED <<running, watchers, damage, rec, before, pids, cs2, director, takes, log, userCs2,
                 crashes, sessions, accepted>>

\* publish pids.json; on failure the launch is recorded damaged and still handed to the watcher
LaunchPids(i) ==
  /\ lpc[i].step = "pids"
  /\ LET n == lpc[i].n IN
     \/ /\ pids' = [pids EXCEPT ![n] = TRUE] /\ UNCHANGED <<damage, result>>
     \/ /\ PidsFail
        /\ damage' = damage \cup {n}
        /\ result' = [result EXCEPT ![n] = IF @ = "none" THEN "damaged" ELSE @]
        /\ UNCHANGED pids
  /\ lpc' = [lpc EXCEPT ![i].step = "handoff"]
  /\ UNCHANGED <<osLock, busy, running, watchers, rec, before, hlae, cs2, director, takes, log,
                 userCs2, crashes, sessions, accepted>>

\* launch_running and watch(): the watcher keeps the OS lock; the guard ends
LaunchHandoff(i) ==
  /\ lpc[i].step = "handoff"
  /\ running' = [running EXCEPT ![i] = @ + 1]
  /\ watchers' = [watchers EXCEPT ![i] = @ \cup {lpc[i].n}]
  /\ lpc' = [lpc EXCEPT ![i] = [step |-> "idle", n |-> None]]
  /\ busy' = [busy EXCEPT ![i] = "idle"]
  /\ UNCHANGED <<osLock, damage, rec, before, pids, result, hlae, cs2, director, takes, log, userCs2,
                 crashes, sessions, accepted>>

\* the watcher: HLAE has exited and no cs2.exe runs; with WatcherSettles it takes the guard, settles its
\* launch, then lets the lock go; without it (44f4312) it only lets the lock go
WatcherEnd(i, n) ==
  /\ n \in watchers[i] /\ hlae[n] = "exited" /\ ~AnyCs2
  /\ IF WatcherSettles
     THEN /\ CanGuard(i)
          /\ result' = [result EXCEPT ![n] = IF @ # "none" THEN @
                                            ELSE IF n \in damage THEN "damaged"
                                            ELSE IF log.owner = n /\ log.ended THEN "ended" ELSE "stopped"]
     ELSE UNCHANGED result
  /\ watchers' = [watchers EXCEPT ![i] = @ \ {n}]
  /\ running' = [running EXCEPT ![i] = @ - 1]
  /\ osLock' = IF busy[i] = "idle" /\ running[i] = 1 THEN "none" ELSE osLock
  /\ UNCHANGED <<busy, damage, lpc, rec, before, pids, hlae, cs2, director, takes, log, userCs2,
                 crashes, sessions, accepted>>

\* clips_scan and clips_finish: settle, then accept every proven take (the scan lists it; finish reads it)
Scan(i) ==
  /\ CanGuard(i) /\ lpc[i].step = "idle"
  /\ LET r == SettleAll(result) IN
     /\ result' = r
     /\ accepted' = accepted \cup {t \in takes : Proven(t, r)}
  /\ osLock' = Release(i)
  /\ UNCHANGED <<busy, running, watchers, damage, lpc, rec, before, pids, hlae, cs2, director, takes,
                 log, userCs2, crashes, sessions>>

\* the instance's process ends, however: its mutex, OS lock, launch steps and watchers go
Crash(i) ==
  /\ crashes < Crashes
  /\ crashes' = crashes + 1
  /\ busy' = [busy EXCEPT ![i] = "idle"]
  /\ running' = [running EXCEPT ![i] = 0]
  /\ watchers' = [watchers EXCEPT ![i] = {}]
  /\ lpc' = [lpc EXCEPT ![i] = [step |-> "idle", n |-> None]]
  /\ osLock' = IF osLock = i THEN "none" ELSE osLock
  /\ UNCHANGED <<damage, rec, before, pids, result, hlae, cs2, director, takes, log, userCs2, sessions,
                 accepted>>

\* ---------------------------------------------------------------- the game

\* HLAE's loader starts CS2, whose -condebug session replaces console.log
Cs2Start(n) ==
  /\ hlae[n] = "running" /\ cs2[n] = "none" /\ ~AnyCs2
  /\ cs2' = [cs2 EXCEPT ![n] = "running"]
  /\ log' = [owner |-> n, ended |-> FALSE]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae,
                 director, takes, userCs2, crashes, sessions, accepted>>

\* the director starts recording the clip: HLAE makes a new take folder
Record(n) ==
  /\ cs2[n] = "running" /\ director[n] = "idle"
  /\ director' = [director EXCEPT ![n] = "recording"]
  /\ takes' = takes \cup {n}
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae, cs2,
                 log, userCs2, crashes, sessions, accepted>>

\* the director ends the clip: at the end tick, or early (camera_lost and the like); its END line lands in
\* console.log, which this session owns
EndClip(n) ==
  /\ cs2[n] = "running" /\ director[n] = "recording"
  /\ \E why \in {"ended", "stopped"} :
       /\ director' = [director EXCEPT ![n] = why]
       /\ log' = [log EXCEPT !.ended = (why = "ended")]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae, cs2,
                 takes, userCs2, crashes, sessions, accepted>>

\* CS2 quits by itself or is closed or crashes, at any point
Cs2Exit(n) ==
  /\ cs2[n] = "running"
  /\ cs2' = [cs2 EXCEPT ![n] = "exited"]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae,
                 director, takes, log, userCs2, crashes, sessions, accepted>>

\* HLAE exits, before or after its CS2
HlaeExit(n) ==
  /\ hlae[n] = "running"
  /\ hlae' = [hlae EXCEPT ![n] = "exited"]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, cs2,
                 director, takes, log, userCs2, crashes, sessions, accepted>>

\* the user plays CS2 normally: the session replaces console.log
UserStart ==
  /\ sessions < UserSessions /\ ~AnyCs2
  /\ userCs2' = TRUE /\ sessions' = sessions + 1
  /\ log' = [owner |-> None, ended |-> FALSE]
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae, cs2,
                 director, takes, crashes, accepted>>

UserQuit ==
  /\ userCs2 /\ userCs2' = FALSE
  /\ UNCHANGED <<osLock, busy, running, watchers, damage, lpc, rec, before, pids, result, hlae, cs2,
                 director, takes, log, crashes, sessions, accepted>>

Next ==
  \/ \E i \in Instances :
       \/ LaunchBegin(i) \/ LaunchRecord(i) \/ LaunchSpawn(i) \/ LaunchPids(i) \/ LaunchHandoff(i)
       \/ Scan(i) \/ Crash(i) \/ \E n \in Launches : WatcherEnd(i, n)
  \/ \E n \in Launches : Cs2Start(n) \/ Record(n) \/ EndClip(n) \/ Cs2Exit(n) \/ HlaeExit(n)
  \/ UserStart \/ UserQuit

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------- properties

TypeOK ==
  /\ osLock \in Instances \cup {"none"}
  /\ result \in [Launches -> Results]
  /\ takes \subseteq Launches /\ accepted \subseteq takes

\* no take is accepted unless its own launch's director recorded it to the end tick
NoTakeWithoutEvidence == \A t \in accepted : director[t] = "ended"
\* a result says "ended" only when that launch's director wrote it
ResultTruthful == \A n \in Launches : result[n] = "ended" => director[n] = "ended"
\* the owner the app infers for a take is the launch that made it
OwnerIsCreator == \A t \in takes : Owner(t) = t
\* at most one launch's HLAE or CS2 runs at a time
OneLaunchAtATime ==
  \A n, m \in Launches : (n # m /\ (hlae[n] = "running" \/ cs2[n] = "running"))
                         => ~(hlae[m] = "running" \/ cs2[m] = "running")
\* completeness: a launch whose director recorded the clip to the end tick settles as ended. Expected to
\* fail whenever the user may start CS2: a normal session that starts after the launch's CS2 exits and
\* before it settles replaces console.log, and the take never counts (it is lost, never misattributed)
EvidenceKept == \A n \in Launches : (director[n] = "ended" /\ result[n] \notin {"none", "damaged"}) => result[n] = "ended"
=============================================================================
