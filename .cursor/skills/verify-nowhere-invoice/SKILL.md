---
name: verify-nowhere-invoice
description: Check method selection, amount limits, and provider responses when changing Nowhere message tip and fundraiser invoice requests.
---

# Verify tip and donation invoice requests

Both commands require a positive whole-sat amount and a Lightning method. They resolve the provider's limits, convert sats to millisats, and request an invoice only within the returned limits.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-invoice
sh scripts/check-cli-state-machine.sh "$skill/Invoice.tla"
node --import tsx "$skill/references/check-invoice-range.mjs"
pnpm exec vitest run tests/e2e/message-tips.test.ts tests/e2e/fundraiser-donate.test.ts
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Both caller modules share the same guards at the two refs. Main adds the bounded network helper to `lightning.ts`.

| Transition | Source |
| --- | --- |
| Resolve the expected site type, read methods and assign IDs | `message-tips.ts`, `listMessageTipMethods`; `fundraiser-donate.ts`, `listFundraiserDonationMethods`; `tips.ts`, `parseTipMethods` |
| Validate integer amount and select Lightning, then enforce limits | `createMessageTipInvoice`, `createFundraiserDonationInvoice` |
| Resolve provider parameters and request invoice, or report an error | `lightning.ts`, `resolveLightningAddress`, `fetchInvoice`; `network.ts`, `fetchWithTimeout` |

The model covers one invocation of either caller. It assumes numeric limits from a well-formed provider response and represents the callback as success or failure. It omits provider URL resolution, timeout duration, invoice contents and downstream settlement. Store checkout has its own model and call ordering.

TLC checked `OnlyEligibleAmountsReachCallback` and `InvoiceRequiresCallback` in 36 states. `Invoice-mutant.cfg` bypasses the provider range check. The mocked provider replay accepts the exact boundaries and rejects amounts outside them before callback, for both CLI flows. It uses local responses throughout. In a disposable checkout, bypass the amount check in either caller. Its corresponding source path fails the fixture. Four existing tests passed. Restore and rerun the source and model checks before updating the reviewed refs. [Invoice statechart](../../../docs/statecharts/invoice.md)
