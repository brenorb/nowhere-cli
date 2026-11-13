# Find orders for a Nowhere store

![Statechart for selecting matching seller orders](seller-orders.svg)

[Mermaid source](seller-orders.mmd) · [Models and local checks](../../.cursor/skills/verify-nowhere-store-live/SKILL.md)

Pstack explored 96 states and checked `ShownOrderMatches` and `NoDeadlock`. This chart covers the disposition of one candidate after relay lookup. It abstracts cryptography, the relay page cursor, and the total result limit. The linked skill includes a separate pagination model and its known failure.

```sh
skill=.cursor/skills/verify-nowhere-store-live
statechart "$skill/OrderView.tla" --view docs/statecharts/seller-orders.view.mjs \
  --out /tmp/nowhere-seller-orders
```
