# Quote and begin a Nowhere store checkout

[Mermaid chart](checkout.mmd) · [Verification skill](../../.cursor/skills/verify-nowhere-checkout/SKILL.md)

![Nowhere store checkout](checkout.svg)

pstack's `/statechart` checked 82 states. The quote describes the cart and available methods. Beginning checkout applies the inventory, cart and buyer checks. The Lightning path publishes before requesting an invoice, so an invoice failure can leave an order published. The manual path returns instructions after publication. The chart groups failures before publication and shows the separate outcome after an invoice failure.

To regenerate, copy `Checkout.tla` and `Checkout.cfg` from the skill and `checkout.view.mjs` from this directory to a scratch directory. Use pstack at `5866df557357d005b3c0c9d3da0d9e739b4bdde3` and the same TLC JAR as the skill.

```sh
"$PSTACK_STATECHART" Checkout.tla --view checkout.view.mjs --out checkout
```
