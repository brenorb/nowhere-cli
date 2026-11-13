------------------------------- MODULE Session -------------------------------
CONSTANT ReuseOnWrite
VARIABLES disk, phase, result
Callers == {"one", "two"}
Terminal == {"done", "failed"}
Init ==
    /\ disk \in {"missing", "saved", "corrupt"}
    /\ phase = [c \in Callers |-> "read"]
    /\ result = [c \in Callers |-> "none"]
UseOverride ==
    /\ \E c \in Callers :
        /\ phase[c] = "read"
        /\ phase' = [phase EXCEPT ![c] = "done"]
        /\ result' = [result EXCEPT ![c] = "override"]
    /\ UNCHANGED disk
Read ==
    /\ \E c \in Callers :
        /\ phase[c] = "read"
        /\ phase' = [phase EXCEPT ![c] =
            CASE disk = "missing" -> "generate"
              [] disk = "corrupt" -> "failed"
              [] OTHER -> "done"]
        /\ result' = [result EXCEPT ![c] =
            IF disk \in {"missing", "corrupt"} THEN "none" ELSE disk]
    /\ UNCHANGED disk
Save ==
    \E c \in Callers :
        /\ phase[c] = "generate"
        /\ phase' = [phase EXCEPT ![c] = "done"]
        /\ disk' = IF ReuseOnWrite /\ disk # "missing" THEN disk ELSE c
        /\ result' = [result EXCEPT ![c] = disk']
SaveError ==
    /\ \E c \in Callers :
        /\ phase[c] = "generate"
        /\ phase' = [phase EXCEPT ![c] = "failed"]
    /\ UNCHANGED <<disk, result>>
Done == (\A c \in Callers : phase[c] \in Terminal) /\ UNCHANGED <<disk, phase, result>>
Next == UseOverride \/ Read \/ Save \/ SaveError \/ Done
ReturnedSessionIsPersisted ==
    \A c \in Callers :
        (phase[c] = "done" /\ result[c] # "override") => result[c] = disk
CorruptFileIsPreserved == disk = "corrupt" => \A c \in Callers : phase[c] # "generate"
=============================================================================
