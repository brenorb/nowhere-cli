------------------------------- MODULE Inventory ------------------------------
CONSTANT FilterAuthor
VARIABLE s
Init ==
    \E present, seller, valid \in BOOLEAN :
        s = [phase |-> "query", present |-> present, seller |-> seller, valid |-> valid]
Fetch ==
    /\ s.phase = "query"
    /\ s' = [s EXCEPT !.phase = IF s.present /\ (s.seller \/ ~FilterAuthor)
                                  THEN "decode" ELSE "unavailable"]
Decode ==
    /\ s.phase = "decode"
    /\ s' = [s EXCEPT !.phase = IF s.valid THEN "visible" ELSE "unavailable"]
Done == s.phase \in {"visible", "unavailable"} /\ UNCHANGED s
Next == Fetch \/ Decode \/ Done
VisibleStatusFromSeller == s.phase = "visible" => s.present /\ s.seller /\ s.valid
=============================================================================
