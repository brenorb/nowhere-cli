---------------------------- MODULE Verification ------------------------------
CONSTANT RequirePaymentCheck
VARIABLE v
Init ==
    \E totals, requested, amountMatches \in BOOLEAN,
       rate \in {"override", "native", "cached", "one provider", "two providers", "unavailable"} :
        v = [phase |-> "totals", totals |-> totals, requested |-> requested,
             rate |-> rate, amountMatches |-> amountMatches, checked |-> FALSE, ok |-> FALSE]
Totals ==
    /\ v.phase = "totals"
    /\ v' = [v EXCEPT !.phase = "rates", !.ok = v.totals]
Rates ==
    /\ v.phase = "rates"
    /\ v' = [v EXCEPT !.phase = "done",
          !.checked = v.requested /\ v.rate # "unavailable",
          !.ok = (v.ok /\ (IF ~v.requested THEN TRUE
                           ELSE IF v.rate = "unavailable" THEN ~RequirePaymentCheck
                           ELSE v.amountMatches))]
Done == v.phase = "done" /\ UNCHANGED v
Next == Totals \/ Rates \/ Done
VerifiedTotalsMatch == v.ok => v.totals
KnownMismatchRejects == v.phase = "done" /\ v.checked /\ ~v.amountMatches => ~v.ok
SuccessChecksRequestedPayment == v.phase = "done" /\ v.ok /\ v.requested => v.checked
=============================================================================
