------------------------------- MODULE Checkout -------------------------------
CONSTANT CheckAvailability
VARIABLE c
Init ==
    \E command \in {"quote", "begin"}, inventory \in {"ok", "missing", "closed"},
       available \in BOOLEAN, method \in {"lightning", "manual"} :
        c = [command |-> command, inventory |-> inventory, available |-> available,
             method |-> method, phase |-> "quoting", published |-> FALSE]
Quote ==
    /\ c.phase = "quoting"
    /\ c' = [c EXCEPT !.phase = IF c.command = "quote" THEN "quote returned" ELSE "gate"]
Gate ==
    /\ c.phase = "gate"
    /\ c' = [c EXCEPT !.phase =
        IF c.inventory = "ok" /\ (c.available \/ ~CheckAvailability)
        THEN "validate" ELSE "failed"]
Validate ==
    /\ c.phase = "validate"
    /\ c' = [c EXCEPT !.phase = "prepare payment"]
Prepare ==
    /\ c.phase = "prepare payment"
    /\ c' = [c EXCEPT !.phase = "publish order"]
Publish ==
    /\ c.phase = "publish order"
    /\ c' = [c EXCEPT !.published = TRUE,
             !.phase = IF c.method = "lightning" THEN "get invoice" ELSE "manual returned"]
Invoice ==
    /\ c.phase = "get invoice"
    /\ c' = [c EXCEPT !.phase = "invoice returned"]
Fail ==
    /\ c.phase \in {"quoting", "validate", "prepare payment", "publish order", "get invoice"}
    /\ c' = [c EXCEPT !.phase = "failed"]
Done ==
    /\ c.phase \in {"quote returned", "invoice returned", "manual returned", "failed"}
    /\ UNCHANGED c
Next == Quote \/ Gate \/ Validate \/ Prepare \/ Publish \/ Invoice \/ Fail \/ Done
PublishedOrderNeedsAvailableCart ==
    c.published => (c.inventory = "ok" /\ c.available)
=============================================================================
