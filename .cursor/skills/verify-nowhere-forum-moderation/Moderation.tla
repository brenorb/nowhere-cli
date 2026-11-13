----------------------------- MODULE Moderation -----------------------------
EXTENDS Integers
CONSTANT ApplyWords
VARIABLES phase, depth, maxDepth, frontier, allowed, word, author, shown
Nodes == {"owner", "direct", "indirect", "unrelated"}
Follow(node) == CASE node = "owner" -> {"direct"}
                  [] node = "direct" -> {"indirect"}
                  [] node = "indirect" -> {"owner"}
                  [] OTHER -> {}
Init ==
    /\ phase = "expand" /\ depth = 0 /\ maxDepth \in (-1)..3
    /\ frontier = {"owner"} /\ allowed = {"owner"}
    /\ word \in BOOLEAN /\ author \in Nodes /\ shown = FALSE
Expand ==
    /\ phase = "expand" /\ maxDepth # (-1) /\ depth < maxDepth /\ frontier # {}
    /\ frontier' = (UNION {Follow(node) : node \in frontier}) \ allowed
    /\ allowed' = allowed \cup frontier'
    /\ depth' = depth + 1
    /\ UNCHANGED <<phase, maxDepth, word, author, shown>>
Filter ==
    /\ phase = "expand"
    /\ (IF maxDepth = (-1) THEN TRUE ELSE depth = maxDepth \/ frontier = {})
    /\ shown' = ((maxDepth = (-1) \/ author \in allowed) /\ (~ApplyWords \/ ~word))
    /\ phase' = "finished"
    /\ UNCHANGED <<depth, maxDepth, frontier, allowed, word, author>>
Done == phase = "finished" /\ UNCHANGED <<phase, depth, maxDepth, frontier, allowed, word, author, shown>>
Next == Expand \/ Filter \/ Done
ShownObeysModeration == shown => ~word /\ (maxDepth = (-1) \/ author \in allowed)
GraphDepthBound == depth <= 3
=============================================================================
