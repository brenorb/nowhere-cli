# Pair and manage a Nowhere remote signer

[Mermaid chart](signer.mmd) · [Verification skill](../../.cursor/skills/verify-nowhere-signer/SKILL.md)

![Nowhere remote signer lifecycle](signer.svg)

pstack's `/statechart` checked 27 states. Pairing waits for the signer, reads its public key, and saves settings. The CLI can check or forget those settings later. The chart hides status checks that leave the file unchanged and groups pairing, public-key and save errors by their visible result.

To regenerate, copy `Signer.tla` and `Signer.cfg` from the skill and `signer.view.mjs` from this directory to a scratch directory. Use pstack at `5866df557357d005b3c0c9d3da0d9e739b4bdde3` and the same TLC JAR as the skill.

```sh
"$PSTACK_STATECHART" Signer.tla --view signer.view.mjs --out signer
```
