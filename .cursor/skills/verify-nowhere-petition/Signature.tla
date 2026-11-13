------------------------------- MODULE Signature -------------------------------
CONSTANT Validate
VARIABLE p
Init ==
    \E valid \in BOOLEAN :
        p = [phase |-> "validate", valid |-> valid, encrypted |-> FALSE,
             proof |-> FALSE, verified |-> FALSE, published |-> FALSE]
ValidateInput ==
    /\ p.phase = "validate"
    /\ p' = [p EXCEPT !.phase = IF p.valid \/ ~Validate THEN "encrypt" ELSE "failed"]
Encrypt ==
    /\ p.phase = "encrypt"
    /\ p' = [p EXCEPT !.phase = "proof of work", !.encrypted = TRUE]
ComputeProof ==
    /\ p.phase = "proof of work"
    /\ p' = [p EXCEPT !.phase = "sign", !.proof = TRUE]
Sign ==
    /\ p.phase = "sign"
    /\ p' = [p EXCEPT !.phase = "publish", !.verified = TRUE]
Publish ==
    /\ p.phase = "publish"
    /\ p' = [p EXCEPT !.phase = "signed", !.published = TRUE]
Fail ==
    /\ p.phase \in {"encrypt", "proof of work", "sign", "publish"}
    /\ p' = [p EXCEPT !.phase = "failed"]
Done == p.phase \in {"signed", "failed"} /\ UNCHANGED p
Next == ValidateInput \/ Encrypt \/ ComputeProof \/ Sign \/ Publish \/ Fail \/ Done
PublishReadySignature == p.published => p.valid /\ p.encrypted /\ p.proof /\ p.verified
=============================================================================
