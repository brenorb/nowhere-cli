------------------------------ MODULE Dispatch -------------------------------
CONSTANT HelpFirst
VARIABLE d
Init ==
    \E help, bare, validFlags \in BOOLEAN :
        d = [phase |-> "parse", help |-> help, bare |-> bare,
             validFlags |-> validFlags, dispatched |-> FALSE]
Parse ==
    /\ d.phase = "parse"
    /\ d' = [d EXCEPT !.phase =
        CASE HelpFirst /\ (d.help \/ d.bare) -> "help"
          [] ~d.validFlags -> "failed"
          [] d.help \/ d.bare -> "help"
          [] OTHER -> "preflight"]
Preflight ==
    /\ d.phase = "preflight"
    /\ \E good \in BOOLEAN :
        d' = [d EXCEPT !.phase = IF good THEN "action" ELSE "failed"]
Action ==
    /\ d.phase = "action"
    /\ d' = [d EXCEPT !.phase = "done", !.dispatched = TRUE]
Done == d.phase \in {"help", "failed", "done"} /\ UNCHANGED d
Next == Parse \/ Preflight \/ Action \/ Done
HelpIsAvailable == d.help \/ d.bare => d.phase \in {"parse", "help"}
InvalidFlagsDoNotDispatch == d.dispatched => d.validFlags
=============================================================================
