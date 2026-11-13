# Request a Nowhere tip or donation invoice

![Statechart for method selection, amount checks, and invoice response](invoice.svg)

[Mermaid source](invoice.mmd) · [Model and local replay](../../.cursor/skills/verify-nowhere-invoice/SKILL.md)

Pstack explored 36 states and checked `OnlyEligibleAmountsReachCallback`, `InvoiceRequiresCallback`, and `NoDeadlock`. The chart abstracts network failures, exact amount limits and provider details. Steps that stay in one chart state are omitted.

```sh
skill=.cursor/skills/verify-nowhere-invoice
statechart "$skill/Invoice.tla" --view docs/statecharts/invoice.view.mjs \
  --out /tmp/nowhere-invoice
```
