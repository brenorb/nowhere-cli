------------------------------- MODULE Invoice -------------------------------
CONSTANT CheckRange
VARIABLE i
Init ==
    \E positive, inRange \in BOOLEAN, method \in {"lightning", "custom", "missing"} :
        i = [phase |-> "validate", positive |-> positive, inRange |-> inRange,
             method |-> method, callback |-> FALSE, invoice |-> FALSE]
Validate ==
    /\ i.phase = "validate"
    /\ i' = [i EXCEPT !.phase = IF i.positive THEN "choose" ELSE "failed"]
Choose ==
    /\ i.phase = "choose"
    /\ i' = [i EXCEPT !.phase = IF i.method = "lightning" THEN "resolve" ELSE "failed"]
Resolve ==
    /\ i.phase = "resolve"
    /\ i' = [i EXCEPT !.phase = IF i.inRange \/ ~CheckRange THEN "callback" ELSE "failed"]
Request ==
    /\ i.phase = "callback"
    /\ i' = [i EXCEPT !.phase = "response", !.callback = TRUE]
Invoice ==
    /\ i.phase = "response"
    /\ i' = [i EXCEPT !.phase = "complete", !.invoice = TRUE]
Fail ==
    /\ i.phase \in {"resolve", "response"}
    /\ i' = [i EXCEPT !.phase = "failed"]
Done == i.phase \in {"failed", "complete"} /\ UNCHANGED i
Next == Validate \/ Choose \/ Resolve \/ Request \/ Invoice \/ Fail \/ Done
OnlyEligibleAmountsReachCallback == i.callback => i.positive /\ i.inRange /\ i.method = "lightning"
InvoiceRequiresCallback == i.invoice => i.callback
=============================================================================
