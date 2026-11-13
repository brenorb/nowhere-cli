------------------------------ MODULE OrderPages ------------------------------
EXTENDS Integers
VARIABLES until, seen, finished
Events == {"first at 2", "second at 2", "older at 1"}
Timestamp(e) == IF e = "older at 1" THEN 1 ELSE 2
Eligible == {e \in Events : Timestamp(e) <= until}
Init == until = 2 /\ seen = {} /\ finished = FALSE
Page ==
    /\ ~finished
    /\ \E e \in Eligible :
        /\ \A other \in Eligible : Timestamp(other) <= Timestamp(e)
        /\ until' = Timestamp(e) - 1
        /\ seen' = seen \cup {e}
    /\ UNCHANGED finished
Empty ==
    /\ ~finished /\ Eligible = {}
    /\ finished' = TRUE
    /\ UNCHANGED <<until, seen>>
Done == finished /\ UNCHANGED <<until, seen, finished>>
Next == Page \/ Empty \/ Done
EveryOrderFetched == finished => seen = Events
NoEventAheadOfCursor == \A e \in seen : Timestamp(e) > until
=============================================================================
