# Create a Nowhere site interactively

[Mermaid chart](create-interactive.mmd) · [Verification skill](../../.cursor/skills/verify-nowhere-builder/SKILL.md)

![Interactive Nowhere site creation](create-interactive.svg)

pstack's `/statechart` checked 22 states. The builder collects missing answers, shows the completed form, and creates a link only after confirmation. Answering no cancels. The chart hides retries that leave the builder on the same phase and groups related validation failures.

To regenerate, copy `Builder.tla` and `Builder.cfg` from the skill and `create-interactive.view.mjs` from this directory to a scratch directory. Use pstack at `5866df557357d005b3c0c9d3da0d9e739b4bdde3` and the same TLC JAR as the skill.

```sh
"$PSTACK_STATECHART" Builder.tla --view create-interactive.view.mjs --out create-interactive
```
