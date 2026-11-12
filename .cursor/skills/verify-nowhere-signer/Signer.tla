------------------------------- MODULE Signer -------------------------------
CONSTANT PreserveInvalidFile
VARIABLE s
Init ==
    \E stored \in {"missing", "valid", "invalid"} :
        s = [phase |-> "idle", stored |-> stored, method |-> "none",
             observation |-> "none", erasedByRead |-> FALSE]
ReadSession ==
    /\ s.phase = "idle"
    /\ s' = [s EXCEPT
        !.stored = IF s.stored = "invalid" /\ ~PreserveInvalidFile THEN "missing" ELSE @,
        !.erasedByRead = (@ \/ (s.stored = "invalid" /\ ~PreserveInvalidFile)),
        !.observation = CASE s.stored = "valid" -> "connected"
                         [] s.stored = "invalid" /\ PreserveInvalidFile -> "read failed"
                         [] OTHER -> "disconnected"]
Disconnect ==
    /\ s.phase = "idle" /\ s.stored \in {"valid", "missing"}
    /\ s' = [s EXCEPT !.stored = "missing", !.observation = "disconnected"]
Begin ==
    /\ s.phase = "idle"
    /\ \E method \in {"bunker", "handshake"} :
        s' = [s EXCEPT !.phase = "authorization", !.method = method, !.observation = "none"]
Authorize ==
    /\ s.phase = "authorization"
    /\ s' = [s EXCEPT !.phase = "identity"]
GetPublicKey ==
    /\ s.phase = "identity"
    /\ s' = [s EXCEPT !.phase = "saving"]
Persist ==
    /\ s.phase = "saving"
    /\ s' = [s EXCEPT !.phase = "idle", !.stored = "valid",
             !.method = "none", !.observation = "connected"]
Fail ==
    /\ s.phase \in {"authorization", "identity", "saving"}
    /\ s' = [s EXCEPT !.phase = "idle", !.method = "none", !.observation = "pairing failed"]
Next == ReadSession \/ Disconnect \/ Begin \/ Authorize \/ GetPublicKey \/ Persist \/ Fail
ReadingPreservesSettings == ~s.erasedByRead
=============================================================================
