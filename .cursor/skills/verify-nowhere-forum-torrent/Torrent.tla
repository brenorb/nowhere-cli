------------------------------- MODULE Torrent -------------------------------
CONSTANT CheckDuplicate
VARIABLE t
Init ==
    \E parsed, enabled, categoryAllowed, titlePresent \in BOOLEAN,
       duplicate \in {"none", "infohash", "title"}, publish \in BOOLEAN :
        t = [phase |-> "parse", parsed |-> parsed, enabled |-> enabled,
             categoryAllowed |-> categoryAllowed, titlePresent |-> titlePresent,
             duplicate |-> duplicate, publish |-> publish, result |-> "none"]
Parse ==
    /\ t.phase = "parse"
    /\ t' = [t EXCEPT !.phase = IF t.parsed THEN "check" ELSE "failed"]
Validate ==
    /\ t.phase = "check"
    /\ t' = [t EXCEPT !.phase = IF t.enabled /\ t.categoryAllowed /\ t.titlePresent
                                 THEN "fetch" ELSE "failed"]
Fetch ==
    /\ t.phase = "fetch"
    /\ t' = [t EXCEPT !.result = t.duplicate,
        !.phase = CASE ~t.publish -> "checked"
                    [] CheckDuplicate /\ t.duplicate # "none" -> "failed"
                    [] OTHER -> "sign"]
Sign ==
    /\ t.phase = "sign"
    /\ t' = [t EXCEPT !.phase = "relay"]
Publish ==
    /\ t.phase = "relay"
    /\ t' = [t EXCEPT !.phase = "published"]
Fail ==
    /\ t.phase \in {"fetch", "sign", "relay"}
    /\ t' = [t EXCEPT !.phase = "failed"]
Done == t.phase \in {"failed", "checked", "published"} /\ UNCHANGED t
Next == Parse \/ Validate \/ Fetch \/ Sign \/ Publish \/ Fail \/ Done
DuplicateNeverPublished == t.phase = "published" => t.result = "none"
RequiresEnabledCategory == t.phase \in {"checked", "published"} =>
    t.parsed /\ t.enabled /\ t.categoryAllowed /\ t.titlePresent
=============================================================================
