--------------------------- MODULE TicketRetention ---------------------------
EXTENDS Integers, FiniteSets

CONSTANTS MaxClock, MaxCycles, MaxFence, RetentionAge, CheckLeaseFence
Assets == {"ticketAsset", "unattachedAsset"}
Workers == {"worker1", "worker2"}

VARIABLES ticket, clock, enabled, ready, stable, assets, jobs, tasks, providerGone,
          cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup

vars == <<ticket, clock, enabled, ready, stable, assets, jobs, tasks, providerGone,
          cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>
IdleTask == [asset |-> "none", lease |-> 0, stage |-> "idle"]
IdleJob == [state |-> "none", lease |-> 0, deadline |-> 0]
InitialAsset(a) == IF a = "ticketAsset" THEN "attached" ELSE "pending"

Init ==
  /\ ticket = [state |-> "active", cycle |-> 0, archivedAt |-> 0]
  /\ clock = 0
  /\ enabled = FALSE
  /\ ready = TRUE
  /\ stable = FALSE
  /\ assets = [a \in Assets |-> InitialAsset(a)]
  /\ jobs = [a \in Assets |-> IdleJob]
  /\ tasks = [w \in Workers |-> IdleTask]
  /\ providerGone = {}
  /\ cycleOutcomes = [cycle \in 1..MaxCycles |-> {}]
  /\ staleWrite = FALSE
  /\ disabledAdmission = FALSE
  /\ invalidCleanup = FALSE

Archive ==
  /\ ticket.state = "active"
  /\ ticket.cycle < MaxCycles
  /\ ticket' = [state |-> "archived", cycle |-> ticket.cycle + 1, archivedAt |-> clock]
  /\ UNCHANGED <<clock, enabled, ready, stable, assets, jobs, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Restore ==
  /\ ticket.state = "archived"
  /\ ticket' = [ticket EXCEPT !.state = "active"]
  /\ cycleOutcomes' = [cycleOutcomes EXCEPT ![ticket.cycle] = @ \cup {"restored"}]
  /\ UNCHANGED <<clock, enabled, ready, stable, assets, jobs, tasks, providerGone,
                 staleWrite, disabledAdmission, invalidCleanup>>

ClaimPurge ==
  LET a == "ticketAsset" IN
  /\ enabled
  /\ ticket.state = "archived"
  /\ clock - ticket.archivedAt >= RetentionAge
  /\ assets[a] = "attached"
  /\ jobs[a].state = "none"
  /\ ticket' = [ticket EXCEPT !.state = "purging"]
  /\ cycleOutcomes' = [cycleOutcomes EXCEPT ![ticket.cycle] = @ \cup {"claimed"}]
  /\ assets' = [assets EXCEPT ![a] = "reserved"]
  /\ jobs' = [jobs EXCEPT ![a].state = "pending"]
  /\ disabledAdmission' = (disabledAdmission \/ ~enabled)
  /\ UNCHANGED <<clock, enabled, ready, stable, tasks, providerGone, staleWrite, invalidCleanup>>

ReserveUnattached(a) ==
  /\ assets[a] = "pending"
  /\ jobs[a].state = "none"
  /\ assets' = [assets EXCEPT ![a] = "reserved"]
  /\ jobs' = [jobs EXCEPT ![a].state = "pending"]
  /\ invalidCleanup' = (invalidCleanup \/ (a = "ticketAsset"))
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission>>

ValidLease(a) == jobs[a].state = "running" /\ clock < jobs[a].deadline
Current(a, lease) == ValidLease(a) /\ lease = jobs[a].lease

\* The archive clock saturates. A lost worker's lease can still time out.
ExpireAbandoned(a) ==
  /\ ValidLease(a)
  /\ \A w \in Workers: tasks[w].asset # a \/ tasks[w].lease # jobs[a].lease
  /\ jobs' = [jobs EXCEPT ![a].deadline = clock]
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, assets, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

\* One key per job. Admission represents a flag-checked claim and dispatch
\* together. Each worker can still return after its lease has been replaced.
Start(a, w) ==
  /\ enabled /\ ready
  /\ assets[a] = "reserved"
  /\ jobs[a].state \in {"pending", "running"} /\ ~ValidLease(a)
  /\ jobs[a].lease < MaxFence
  /\ tasks[w] = IdleTask
  /\ LET lease == jobs[a].lease + 1 IN
     /\ jobs' = [jobs EXCEPT ![a] = [state |-> "running", lease |-> lease, deadline |-> clock + 1]]
     /\ tasks' = [tasks EXCEPT ![w] = [asset |-> a, lease |-> lease, stage |-> "issued"]]
  /\ disabledAdmission' = (disabledAdmission \/ ~enabled)
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, assets, providerGone,
                 cycleOutcomes, staleWrite, invalidCleanup>>

FinishIO(w) ==
  /\ tasks[w].stage = "issued"
  /\ ready
  /\ providerGone' = providerGone \cup {tasks[w].asset}
  /\ tasks' = [tasks EXCEPT ![w].stage = "returned"]
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, assets, jobs, cycleOutcomes,
                 staleWrite, disabledAdmission, invalidCleanup>>

Crash(w) ==
  /\ ~stable
  /\ tasks[w] # IdleTask
  /\ tasks' = [tasks EXCEPT ![w] = IdleTask]
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, assets, jobs, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Settle(w) ==
  /\ tasks[w].stage = "returned"
  /\ LET a == tasks[w].asset IN
     /\ ValidLease(a)
     /\ (~CheckLeaseFence \/ tasks[w].lease = jobs[a].lease)
     /\ staleWrite' = (staleWrite \/ ~Current(a, tasks[w].lease))
     /\ assets' = [assets EXCEPT ![a] = "deleted"]
     /\ jobs' = [jobs EXCEPT ![a].state = IF a = "ticketAsset" THEN "finalize" ELSE "done"]
  /\ tasks' = [tasks EXCEPT ![w] = IdleTask]
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, providerGone,
                 cycleOutcomes, disabledAdmission, invalidCleanup>>

DiscardStale(w) ==
  /\ tasks[w].stage = "returned"
  /\ ~Current(tasks[w].asset, tasks[w].lease)
  /\ tasks' = [tasks EXCEPT ![w] = IdleTask]
  /\ UNCHANGED <<ticket, clock, enabled, ready, stable, assets, jobs, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Finalize ==
  /\ ticket.state = "purging"
  /\ jobs["ticketAsset"].state = "finalize"
  /\ ticket' = [ticket EXCEPT !.state = "purged"]
  /\ jobs' = [jobs EXCEPT !["ticketAsset"].state = "done"]
  /\ UNCHANGED <<clock, enabled, ready, stable, assets, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<ticket, enabled, ready, stable, assets, jobs, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

ToggleCleanup ==
  /\ enabled' = ~enabled
  /\ UNCHANGED <<ticket, clock, ready, stable, assets, jobs, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

ToggleAvailability ==
  /\ ready' = ~ready
  /\ UNCHANGED <<ticket, clock, enabled, stable, assets, jobs, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Stabilize ==
  /\ ~stable
  /\ stable' = TRUE
  /\ UNCHANGED <<ticket, clock, enabled, ready, assets, jobs, tasks, providerGone,
                 cycleOutcomes, staleWrite, disabledAdmission, invalidCleanup>>

Next ==
  \/ Archive \/ Restore \/ ClaimPurge \/ Finalize \/ Tick
  \/ ToggleCleanup \/ ToggleAvailability \/ Stabilize
  \/ \E a \in Assets: ReserveUnattached(a) \/ ExpireAbandoned(a) \/ (\E w \in Workers: Start(a, w))
  \/ \E w \in Workers: FinishIO(w) \/ Crash(w) \/ Settle(w) \/ DiscardStale(w)

SafetySpec == Init /\ [][Next]_vars

TypeOK ==
  /\ ticket \in [state: {"active", "archived", "purging", "purged"}, cycle: 0..MaxCycles, archivedAt: 0..MaxClock]
  /\ clock \in 0..MaxClock
  /\ enabled \in BOOLEAN /\ ready \in BOOLEAN /\ stable \in BOOLEAN
  /\ assets \in [Assets -> {"attached", "pending", "reserved", "deleted"}]
  /\ jobs \in [Assets -> [state: {"none", "pending", "running", "finalize", "done"},
                          lease: 0..MaxFence, deadline: 0..(MaxClock + 1)]]
  /\ tasks \in [Workers -> [asset: Assets \cup {"none"}, lease: 0..MaxFence, stage: {"idle", "issued", "returned"}]]
  /\ providerGone \subseteq Assets
  /\ cycleOutcomes \in [1..MaxCycles -> SUBSET {"claimed", "restored"}]
  /\ staleWrite \in BOOLEAN /\ disabledAdmission \in BOOLEAN /\ invalidCleanup \in BOOLEAN

AttachedAssetSafe ==
  /\ ~invalidCleanup
  /\ ticket.state \in {"active", "archived"} => assets["ticketAsset"] = "attached"

RestoreExcludesPurge ==
  \A cycle \in 1..MaxCycles: Cardinality(cycleOutcomes[cycle]) <= 1

NoStaleWrite == ~staleWrite
NoDisabledAdmission == ~disabledAdmission

CompletionSafe ==
  /\ \A a \in Assets: jobs[a].state = "done" => assets[a] = "deleted" /\ a \in providerGone
  /\ ticket.state = "purged" => jobs["ticketAsset"].state = "done"

StartJob(a) == \E w \in Workers: Start(a, w)
WorkerStep(w) == FinishIO(w) \/ Settle(w) \/ DiscardStale(w)
ProgressSpec ==
  /\ SafetySpec
  /\ WF_vars(Tick)
  /\ \A a \in Assets: WF_vars(StartJob(a))
  /\ \A a \in Assets: WF_vars(ExpireAbandoned(a))
  /\ \A w \in Workers: WF_vars(WorkerStep(w))
  /\ WF_vars(Finalize)

\* An abandoned job at the fence bound needs a larger model. Durable work
\* which has already checkpointed needs only database finalization.
HasCapacity(a) == jobs[a].lease < MaxFence \/ ValidLease(a) \/ jobs[a].state \in {"finalize", "done"}
AdmittedJobsFinish ==
  \A a \in Assets:
    (<>[](enabled /\ ready /\ stable /\ HasCapacity(a))) =>
      ((jobs[a].state # "none") ~> (jobs[a].state = "done"))

=============================================================================
