------------------------------- MODULE Builder -------------------------------
CONSTANT HonorDecline
VARIABLE p
Init ==
    \E chooseTool, requiredMissing \in BOOLEAN :
        p = [phase |-> "validate flags", chooseTool |-> chooseTool,
             requiredMissing |-> requiredMissing, declined |-> FALSE, promptOpen |-> FALSE]
RejectFlags ==
    /\ p.phase = "validate flags"
    /\ p' = [p EXCEPT !.phase = "failed"]
Open ==
    /\ p.phase = "validate flags"
    /\ p' = [p EXCEPT !.phase = IF p.chooseTool THEN "choose tool" ELSE "fill fields",
             !.promptOpen = TRUE]
ChooseTool ==
    /\ p.phase = "choose tool"
    /\ p' = [p EXCEPT !.phase = "fill fields"]
FillRequired ==
    /\ p.phase = "fill fields" /\ p.requiredMissing
    /\ p' = [p EXCEPT !.requiredMissing = FALSE]
Review ==
    /\ p.phase = "fill fields" /\ ~p.requiredMissing
    /\ p' = [p EXCEPT !.phase = "review"]
PromptFailure ==
    /\ p.phase \in {"choose tool", "fill fields", "review"}
    /\ p' = [p EXCEPT !.phase = "failed", !.promptOpen = FALSE]
Retry ==
    /\ p.phase \in {"choose tool", "fill fields", "review"}
    /\ UNCHANGED p
Confirm ==
    /\ p.phase = "review"
    /\ p' = [p EXCEPT !.phase = "build", !.promptOpen = FALSE]
Decline ==
    /\ p.phase = "review"
    /\ p' = [p EXCEPT !.phase = IF HonorDecline THEN "cancelled" ELSE "build",
                     !.declined = TRUE, !.promptOpen = FALSE]
Build ==
    /\ p.phase = "build"
    /\ p' = [p EXCEPT !.phase = "created"]
BuildFails ==
    /\ p.phase = "build"
    /\ p' = [p EXCEPT !.phase = "failed"]
Done ==
    /\ p.phase \in {"created", "cancelled", "failed"}
    /\ UNCHANGED p
Next == RejectFlags \/ Open \/ ChooseTool \/ FillRequired \/ Review \/ PromptFailure
        \/ Retry \/ Confirm \/ Decline \/ Build \/ BuildFails \/ Done
DeclinePreventsCreation == p.declined => p.phase \notin {"build", "created"}
=============================================================================
