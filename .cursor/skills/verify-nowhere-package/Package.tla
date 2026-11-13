------------------------------- MODULE Package --------------------------------
CONSTANT RequireBundledCodec
VARIABLE p
Init ==
    \E build, codec \in BOOLEAN :
        p = [phase |-> "build", build |-> build, codec |-> codec]
Build ==
    /\ p.phase = "build"
    /\ p' = [p EXCEPT !.phase = IF p.build THEN "pack" ELSE "failed"]
Pack ==
    /\ p.phase = "pack"
    /\ p' = [p EXCEPT !.phase = "install"]
Install ==
    /\ p.phase = "install"
    /\ p' = [p EXCEPT !.phase = "check"]
Check ==
    /\ p.phase = "check"
    /\ p' = [p EXCEPT !.phase = IF p.codec \/ ~RequireBundledCodec THEN "usable" ELSE "failed"]
Fail == p.phase \in {"pack", "install"} /\ p' = [p EXCEPT !.phase = "failed"]
Done == p.phase \in {"usable", "failed"} /\ UNCHANGED p
Next == Build \/ Pack \/ Install \/ Check \/ Fail \/ Done
InstalledCliIsSelfContained == p.phase = "usable" => p.build /\ p.codec
=============================================================================
