-------------------------------- MODULE Watch --------------------------------
CONSTANT Deduplicate
VARIABLE w
Events == {"first", "second"}
Init ==
    w = [phase |-> "snapshot", busy |-> FALSE, stop |-> FALSE, expired |-> FALSE,
         seen |-> {}, repeats |-> FALSE, live |-> FALSE]
Poll ==
    /\ w.phase \in {"snapshot", "live"} /\ ~w.busy /\ ~w.stop
    /\ w' = [w EXCEPT !.busy = TRUE]
Arrive ==
    /\ w.busy
    /\ \E batch \in SUBSET Events :
        w' = [w EXCEPT !.phase = "waiting", !.busy = FALSE,
                       !.seen = @ \cup batch,
                       !.repeats = @ \/ (~Deduplicate /\ (w.seen \cap batch # {})),
                       !.live = w.phase = "live"]
ListError ==
    /\ w.busy
    /\ w' = [w EXCEPT !.phase = "failed", !.busy = FALSE]
NextPoll ==
    /\ w.phase = "waiting" /\ ~w.stop /\ ~w.expired
    /\ w' = [w EXCEPT !.phase = "live"]
Signal ==
    /\ w.phase \notin {"finished", "failed"} /\ ~w.stop
    /\ w' = [w EXCEPT !.stop = TRUE]
Deadline ==
    /\ w.phase \notin {"finished", "failed"} /\ ~w.expired
    /\ w' = [w EXCEPT !.expired = TRUE]
Finish ==
    /\ w.phase \notin {"finished", "failed"} /\ ~w.busy
    /\ w.stop \/ (w.phase = "waiting" /\ w.expired)
    /\ w' = [w EXCEPT !.phase = "finished"]
Done == w.phase \in {"finished", "failed"} /\ UNCHANGED w
Next == Poll \/ Arrive \/ ListError \/ NextPoll \/ Signal \/ Deadline \/ Finish \/ Done
NoRepeatedEvent == ~w.repeats
=============================================================================
