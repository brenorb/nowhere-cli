-------------------------------- MODULE Chat ---------------------------------
CONSTANT CheckTarget
VARIABLE c
Init ==
    \E channel \in {"general", "room", "private"}, keyOk, shapeOk, sigOk, targetOk \in BOOLEAN :
        c = [phase |-> "read", channel |-> channel, keyOk |-> keyOk, shapeOk |-> shapeOk,
             sigOk |-> sigOk, targetOk |-> targetOk]
Decrypt ==
    /\ c.phase = "read"
    /\ c' = [c EXCEPT !.phase = IF c.keyOk THEN "validate" ELSE "skip"]
Validate ==
    /\ c.phase = "validate"
    /\ c' = [c EXCEPT !.phase =
        IF c.shapeOk /\ (c.targetOk \/ ~CheckTarget) /\ c.sigOk
        THEN "shown" ELSE "skip"]
Done == c.phase \in {"shown", "skip"} /\ UNCHANGED c
Next == Decrypt \/ Validate \/ Done
ShownMatchesChannel == c.phase = "shown" => c.keyOk /\ c.shapeOk /\ c.targetOk /\ c.sigOk
=============================================================================
