------------------------------- MODULE Rates ----------------------------------
VARIABLE r
Init ==
    \E direct \in {"override", "native", "cached", "none"} :
        r = [phase |-> "select", direct |-> direct, kraken |-> "pending",
             coingecko |-> "pending", source |-> "none"]
Select ==
    /\ r.phase = "select"
    /\ r' = [r EXCEPT !.phase = IF r.direct = "none" THEN "fetch" ELSE "done",
                       !.source = r.direct]
Kraken ==
    /\ r.phase = "fetch" /\ r.kraken = "pending"
    /\ \E outcome \in {"rate", "failed"} : r' = [r EXCEPT !.kraken = outcome]
Coingecko ==
    /\ r.phase = "fetch" /\ r.coingecko = "pending"
    /\ \E outcome \in {"rate", "failed"} : r' = [r EXCEPT !.coingecko = outcome]
Combine ==
    /\ r.phase = "fetch" /\ r.kraken # "pending" /\ r.coingecko # "pending"
    /\ r' = [r EXCEPT !.phase = "done", !.source =
          CASE r.kraken = "rate" /\ r.coingecko = "rate" -> "both"
            [] r.kraken = "rate" -> "kraken"
            [] r.coingecko = "rate" -> "coingecko"
            [] OTHER -> "unavailable"]
Done == r.phase = "done" /\ UNCHANGED r
Next == Select \/ Kraken \/ Coingecko \/ Combine \/ Done
AvailableProviderUsed == r.phase = "done" /\ r.direct = "none" =>
    (r.source = "unavailable") = (r.kraken = "failed" /\ r.coingecko = "failed")
DirectSourceSkipsProviders == r.direct # "none" => r.kraken = "pending" /\ r.coingecko = "pending"
=============================================================================
