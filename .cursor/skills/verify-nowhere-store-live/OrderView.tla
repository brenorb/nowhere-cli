------------------------------- MODULE OrderView ------------------------------
CONSTANT FilterStore
VARIABLE o
Init ==
    \E access, decrypts, sameStore, repeat, matchesId \in BOOLEAN :
        o = [phase |-> "access", access |-> access, decrypts |-> decrypts,
             sameStore |-> sameStore, repeat |-> repeat, matchesId |-> matchesId]
Authorize ==
    /\ o.phase = "access"
    /\ o' = [o EXCEPT !.phase = IF o.access THEN "fetch" ELSE "failed"]
Fetch ==
    /\ o.phase = "fetch"
    /\ o' = [o EXCEPT !.phase = "decrypt"]
Decrypt ==
    /\ o.phase = "decrypt"
    /\ o' = [o EXCEPT !.phase =
        CASE ~o.decrypts -> "failed"
          [] (~o.sameStore /\ FilterStore) \/ o.repeat \/ ~o.matchesId -> "skip"
          [] OTHER -> "shown"]
Done == o.phase \in {"failed", "skip", "shown"} /\ UNCHANGED o
Next == Authorize \/ Fetch \/ Decrypt \/ Done
ShownOrderMatches == o.phase = "shown" =>
    o.access /\ o.decrypts /\ o.sameStore /\ ~o.repeat /\ o.matchesId
=============================================================================
