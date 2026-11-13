----------------------------- MODULE Deadline ------------------------------
CONSTANT UseDeadline, CombineCaller
VARIABLES hasCaller, phase
vars == <<hasCaller, phase>>
Init == /\ hasCaller \in BOOLEAN /\ phase = "pending"
Respond == /\ phase = "pending" /\ phase' = "headers" /\ UNCHANGED hasCaller
Deadline ==
  /\ phase \in {"pending", "headers"}
  /\ phase' = IF UseDeadline THEN "timed out" ELSE "past deadline"
  /\ UNCHANGED hasCaller
CallerAbort ==
  /\ hasCaller /\ phase \in {"pending", "headers"}
  /\ phase' = IF CombineCaller THEN "cancelled" ELSE "ignored caller"
  /\ UNCHANGED hasCaller
ReadBody == /\ phase = "headers" /\ phase' = "complete" /\ UNCHANGED hasCaller
Next == Respond \/ Deadline \/ CallerAbort \/ ReadBody \/ UNCHANGED vars
DeadlineApplied == phase /= "past deadline"
CallerCancellationApplied == phase /= "ignored caller"
=============================================================================
