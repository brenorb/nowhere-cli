# Create, update, and verify a protected link

[Mermaid chart](site-protection.mmd) · [Verification skill](../../.cursor/skills/verify-nowhere-site-protection/SKILL.md)

![Nowhere create, update, and verify a protected link](site-protection.svg)

pstack's `/statechart` checked 66 states. The chart follows creating a page or opening an existing page for an update, applying the protections selected for the new link, and checking that link. It hides terminal stutters and combines related build and protection errors into one failure state.

To regenerate in a scratch directory, copy `SiteProtection.tla` and `SiteProtection.cfg` from the verification skill and copy `site-protection.view.mjs` from this directory. Use pstack at `5866df557357d005b3c0c9d3da0d9e739b4bdde3` and the same pinned TLC JAR as the verification skill.

```sh
"$PSTACK_STATECHART" SiteProtection.tla --view site-protection.view.mjs --out nowhere-site-protection
```
