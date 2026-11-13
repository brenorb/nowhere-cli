-------------------------------- MODULE Posts --------------------------------
CONSTANT EnforceIdentity
VARIABLE p
Init ==
    \E kind \in {"post", "reply"}, mode \in {"signed", "anonymous", "either"},
       signed, sizeOk, targetOk \in BOOLEAN :
        p = [phase |-> "validate", kind |-> kind, mode |-> mode, signed |-> signed,
             sizeOk |-> sizeOk, targetOk |-> targetOk]
AuthorAllowed == p.mode = "either" \/ (p.mode = "signed" <=> p.signed)
Validate ==
    /\ p.phase = "validate"
    /\ p' = [p EXCEPT !.phase =
        IF p.sizeOk /\ p.targetOk /\ (AuthorAllowed \/ ~EnforceIdentity)
        THEN "sign" ELSE "failed"]
Sign == p.phase = "sign" /\ p' = [p EXCEPT !.phase = "encrypted"]
Publish == p.phase = "encrypted" /\ p' = [p EXCEPT !.phase = "published"]
Fail == p.phase \in {"sign", "encrypted"} /\ p' = [p EXCEPT !.phase = "failed"]
Done == p.phase \in {"published", "failed"} /\ UNCHANGED p
Next == Validate \/ Sign \/ Publish \/ Fail \/ Done
PublishedMeetsPolicy == p.phase = "published" => p.sizeOk /\ p.targetOk /\ AuthorAllowed
=============================================================================
