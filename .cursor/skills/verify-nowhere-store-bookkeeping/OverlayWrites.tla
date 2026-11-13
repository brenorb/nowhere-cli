---------------------------- MODULE OverlayWrites -----------------------------
CONSTANT MergeAtCommit
VARIABLES disk, phase, snapshot
Updates == {"note", "hide"}
Init ==
    /\ disk = {}
    /\ phase = [update \in Updates |-> "read"]
    /\ snapshot = [update \in Updates |-> {}]
Read ==
    /\ \E update \in Updates :
        /\ phase[update] = "read"
        /\ phase' = [phase EXCEPT ![update] = "write"]
        /\ snapshot' = [snapshot EXCEPT ![update] = disk]
    /\ UNCHANGED disk
Write ==
    /\ \E update \in Updates :
        /\ phase[update] = "write"
        /\ phase' = [phase EXCEPT ![update] = "done"]
        /\ disk' = (IF MergeAtCommit THEN disk ELSE snapshot[update]) \cup {update}
    /\ UNCHANGED snapshot
Done == (\A update \in Updates : phase[update] = "done") /\ UNCHANGED <<disk, phase, snapshot>>
Next == Read \/ Write \/ Done
AcknowledgedUpdatesPersist == {update \in Updates : phase[update] = "done"} \subseteq disk
=============================================================================
