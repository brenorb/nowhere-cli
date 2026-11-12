--------------------------------- MODULE RPC ---------------------------------
CONSTANT HasDeadline
VARIABLE q
Init == q = [phase |-> "idle", subscription |-> "closed",
             authShown |-> FALSE, deadline |-> FALSE]
Send ==
    /\ q.phase = "idle"
    /\ q' = [q EXCEPT !.phase = "pending", !.subscription = "open"]
Notice ==
    /\ q.phase = "pending" /\ ~q.authShown
    /\ q' = [q EXCEPT !.authShown = TRUE]
SubscriptionLost ==
    /\ q.phase = "pending" /\ q.subscription = "open"
    /\ q' = [q EXCEPT !.subscription = "retry scheduled"]
Reopen ==
    /\ q.phase = "pending" /\ q.subscription = "retry scheduled"
    /\ q' = [q EXCEPT !.subscription = "open"]
Reply ==
    /\ q.phase = "pending" /\ q.subscription = "open"
    /\ q' = [q EXCEPT !.phase = "resolved"]
Reject ==
    /\ q.phase = "pending"
    /\ q' = [q EXCEPT !.phase = "rejected"]
Elapsed ==
    /\ q.phase = "pending" /\ ~q.deadline
    /\ q' = [q EXCEPT !.deadline = TRUE, !.phase = IF HasDeadline THEN "timed out" ELSE @]
Close ==
    /\ q.phase \in {"idle", "pending", "resolved", "rejected", "timed out"}
    /\ q' = [q EXCEPT !.phase = "closed", !.subscription = "closed"]
Done == q.phase = "closed" /\ UNCHANGED q
Next == Send \/ Notice \/ SubscriptionLost \/ Reopen \/ Reply \/ Reject \/ Elapsed \/ Close \/ Done
DeadlineSettlesRequest == q.deadline => q.phase # "pending"
=============================================================================
