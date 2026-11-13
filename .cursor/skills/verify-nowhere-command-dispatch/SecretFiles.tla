----------------------------- MODULE SecretFiles -----------------------------
CONSTANT RejectConflict
VARIABLE s
Init ==
    \E required, inline, file, readable \in BOOLEAN :
        s = [phase |-> "preflight", required |-> required, inline |-> inline,
             file |-> file, readable |-> readable, loaded |-> FALSE]
Preflight ==
    /\ s.phase = "preflight"
    /\ s' = [s EXCEPT !.phase =
        CASE s.inline /\ s.file /\ RejectConflict -> "failed"
          [] s.file -> "read"
          [] s.inline \/ ~s.required -> "action"
          [] OTHER -> "failed"]
ReadFile ==
    /\ s.phase = "read"
    /\ s' = [s EXCEPT !.phase = IF s.readable THEN "action" ELSE "failed",
                       !.loaded = s.readable]
Done == s.phase \in {"failed", "action"} /\ UNCHANGED s
Next == Preflight \/ ReadFile \/ Done
OneSecretSource == s.phase = "action" => ~(s.inline /\ s.file)
RequiredSecretResolved == s.phase = "action" /\ s.required => s.inline \/ s.loaded
=============================================================================
