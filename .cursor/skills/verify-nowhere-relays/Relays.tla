-------------------------------- MODULE Relays --------------------------------
CONSTANTS Relays, FilterConnectionFailures
VARIABLE r
Init ==
    \E mode \in {"strict", "best effort"} :
        r = [mode |-> mode, results |-> [relay \in Relays |-> "pending"],
             phase |-> "waiting"]
Settled == \A relay \in Relays : r.results[relay] # "pending"
Accepted == \E relay \in Relays : r.results[relay] = "accepted"
FulfilledFailure == \E relay \in Relays : r.results[relay] = "connection failure"
Settle ==
    /\ r.phase = "waiting"
    /\ \E relay \in Relays, outcome \in {"accepted", "connection failure", "rejected"} :
        /\ r.results[relay] = "pending"
        /\ r' = [r EXCEPT !.results[relay] = outcome]
Report ==
    /\ r.phase = "waiting" /\ Settled
    /\ r' = [r EXCEPT !.phase =
        IF r.mode = "best effort" \/ Accepted \/ (~FilterConnectionFailures /\ FulfilledFailure)
        THEN "returned" ELSE "failed"]
Done == r.phase \in {"returned", "failed"} /\ UNCHANGED r
Next == Settle \/ Report \/ Done
StrictReturnNeedsAcceptance == (r.mode = "strict" /\ r.phase = "returned") => Accepted
=============================================================================
