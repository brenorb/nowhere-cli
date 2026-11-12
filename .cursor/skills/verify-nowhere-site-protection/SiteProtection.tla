----------------------------- MODULE SiteProtection -----------------------------

CONSTANT WrapActiveFragment
VARIABLE link

Init ==
    \E command \in {"create", "update"}, wantsSign, wantsEncryption \in BOOLEAN:
        link = [command |-> command, phase |-> IF command = "create" THEN "building" ELSE "importing",
                wantsSign |-> wantsSign, wantsEncryption |-> wantsEncryption,
                signature |-> FALSE, encrypted |-> FALSE, printed |-> FALSE, verified |-> "unchecked"]

ImportExisting ==
    /\ link.phase = "importing"
    /\ link' = [link EXCEPT !.phase = "building"]

BuildNewFragment ==
    /\ link.phase = "building"
    /\ link' = [link EXCEPT !.phase = "unsigned"]

SignNewFragment ==
    /\ link.phase = "unsigned" /\ link.wantsSign
    /\ link' = [link EXCEPT !.phase = "signed", !.signature = TRUE]

EncryptFinalFragment ==
    /\ link.wantsEncryption
    /\ link.phase = (IF link.wantsSign THEN "signed" ELSE "unsigned")
    /\ link' = [link EXCEPT !.phase = "encrypted", !.encrypted = TRUE,
                           !.signature = (WrapActiveFragment /\ @)]

PrintFinalLink ==
    /\ link.phase = (IF link.wantsEncryption THEN "encrypted"
                      ELSE IF link.wantsSign THEN "signed" ELSE "unsigned")
    /\ link' = [link EXCEPT !.phase = "published", !.printed = TRUE]

BuildOrProtectFails ==
    /\ (link.phase \in {"importing", "building"}
       \/ (link.phase = "unsigned" /\ link.wantsSign)
       \/ (link.wantsEncryption /\ link.phase = (IF link.wantsSign THEN "signed" ELSE "unsigned")))
    /\ link' = [link EXCEPT !.phase = "failed"]

OpenForVerification ==
    /\ link.phase = "published"
    /\ link' = [link EXCEPT !.phase = "verifying"]

PasswordRejected ==
    /\ link.phase = "verifying" /\ link.encrypted
    /\ link' = [link EXCEPT !.phase = "unreadable"]

VerifySignature ==
    /\ link.phase = "verifying"
    /\ link' = [link EXCEPT !.phase = "verified",
                           !.verified = IF link.signature THEN "signed" ELSE "unsigned"]

Done ==
    /\ link.phase \in {"failed", "verified", "unreadable", "published"}
    /\ UNCHANGED link

Next == ImportExisting \/ BuildNewFragment \/ SignNewFragment \/ EncryptFinalFragment
        \/ PrintFinalLink \/ BuildOrProtectFails \/ OpenForVerification
        \/ PasswordRejected \/ VerifySignature \/ Done

EncryptionPreservesRequestedSignature ==
    (link.printed /\ link.wantsSign /\ link.wantsEncryption) =>
        (link.signature /\ link.encrypted)

=============================================================================
