------------------------------- MODULE Signals --------------------------------
CONSTANT CheckChannel
VARIABLE v
Init ==
    \E channel \in {"general", "room", "private"}, kind \in {"join", "other"},
       decrypts, shapeOk, channelOk, authorOk, joinSigOk \in BOOLEAN :
        v = [phase |-> "read", channel |-> channel, kind |-> kind,
             decrypts |-> decrypts, shapeOk |-> shapeOk, channelOk |-> channelOk,
             authorOk |-> authorOk, joinSigOk |-> joinSigOk, reportedValid |-> FALSE]
Decrypt ==
    /\ v.phase = "read"
    /\ v' = [v EXCEPT !.phase = IF v.decrypts THEN "validate" ELSE "skip"]
Filter ==
    /\ v.phase = "validate"
    /\ v' = [v EXCEPT
        !.phase = IF v.shapeOk /\ v.authorOk /\ (v.channelOk \/ ~CheckChannel)
                  THEN "listed" ELSE "skip",
        !.reportedValid = v.kind # "join" \/ v.joinSigOk]
Done == v.phase \in {"listed", "skip"} /\ UNCHANGED v
Next == Decrypt \/ Filter \/ Done
ListedSignalsMatch == v.phase = "listed" =>
    v.decrypts /\ v.shapeOk /\ v.authorOk /\ v.channelOk
JoinStatusMatches == v.phase = "listed" /\ v.kind = "join" =>
    v.reportedValid = v.joinSigOk
=============================================================================
