------------------------------ MODULE RelayCount ------------------------------
EXTENDS Integers
CONSTANTS Relays, TakeLargest
VARIABLE c
Pending == -1
Failed == -2
Init == c = [results |-> [relay \in Relays |-> Pending],
             phase |-> "counting", value |-> 0]
Numbers == {n \in 0..2 : \E relay \in Relays : c.results[relay] = n}
Settled == \A relay \in Relays : c.results[relay] # Pending
Reply ==
    /\ c.phase = "counting"
    /\ \E relay \in Relays, outcome \in (0..2) \cup {Failed} :
        /\ c.results[relay] = Pending
        /\ c' = [c EXCEPT !.results[relay] = outcome]
Count ==
    /\ c.phase = "counting" /\ Settled /\ Numbers # {}
    /\ \E n \in Numbers :
        /\ ~TakeLargest \/ (\A m \in Numbers : m <= n)
        /\ c' = [c EXCEPT !.phase = "reported count", !.value = n]
Fallback ==
    /\ c.phase = "counting" /\ Settled /\ Numbers = {}
    /\ c' = [c EXCEPT !.phase = "query"]
Query ==
    /\ c.phase = "query"
    /\ \E n \in 0..2 : c' = [c EXCEPT !.phase = "reported query", !.value = n]
QueryFails ==
    /\ c.phase = "query"
    /\ c' = [c EXCEPT !.phase = "failed"]
Done == c.phase \in {"reported count", "reported query", "failed"} /\ UNCHANGED c
Next == Reply \/ Count \/ Fallback \/ Query \/ QueryFails \/ Done
ReportLargestCount ==
    c.phase = "reported count" => \A n \in Numbers : n <= c.value
=============================================================================
