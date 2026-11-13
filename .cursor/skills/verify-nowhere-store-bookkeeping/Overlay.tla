------------------------------- MODULE Overlay -------------------------------
CONSTANT PreserveStatus
VARIABLE o
Statuses == {"new", "confirmed", "processing", "fulfilled", "refunded", "no_payment"}
Init ==
    o = [status |-> "new", confirmed |-> FALSE, hidden |-> FALSE,
         note |-> FALSE, overwritten |-> FALSE]
SetStatus ==
    \E status \in Statuses :
        o' = [o EXCEPT !.status = status]
Confirm ==
    o' = [o EXCEPT !.confirmed = TRUE,
          !.status = IF o.status = "new" \/ ~PreserveStatus THEN "confirmed" ELSE o.status,
          !.overwritten = @ \/ (~PreserveStatus /\ o.status \notin {"new", "confirmed"})]
Unconfirm == o' = [o EXCEPT !.confirmed = FALSE]
Hide == o' = [o EXCEPT !.hidden = TRUE]
Unhide == o' = [o EXCEPT !.hidden = FALSE]
SetNote == \E present \in BOOLEAN : o' = [o EXCEPT !.note = present]
Next == SetStatus \/ Confirm \/ Unconfirm \/ Hide \/ Unhide \/ SetNote
ConfirmationKeepsExistingStatus == ~o.overwritten
=============================================================================
