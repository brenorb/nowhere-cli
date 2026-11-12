---
name: verify-nowhere-checkout
description: Check Nowhere store quote, inventory and cart gates, order publication, and Lightning or manual checkout outcomes.
---

# Verify store checkout gates

An unavailable cart must not publish an order. The quote can still be returned so the buyer can see what prevents checkout.

Run with Java 11 or later and `TLA2TOOLS` pointing to the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-checkout/Checkout.tla
node --import tsx .cursor/skills/verify-nowhere-checkout/references/check-availability.mjs
pnpm exec vitest run tests/e2e/store-live.test.ts
```

## Coverage

Reviewed at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. The release uses the same gates and publication order, with different timeout handling for exchange-rate fetches.

| Transition | Source |
| --- | --- |
| Read the store, cart and optional inventory, calculate quote and methods | `src/lib/store-checkout.ts`, `quoteStoreCheckout`, `resolveCartItems`, `fetchInventoryGate`, `quotePaymentMethods` |
| Reject missing or closed inventory and unavailable items before publication | `beginStoreCheckout` |
| Validate buyer fields, country and method, prepare the amount, and publish | `validateBuyerData`, `requireMethod`, `beginStoreCheckout`; `src/lib/store-live.ts`, `publishOrderReceipt` |
| After publication, request a Lightning invoice or return manual instructions | `beginStoreCheckout`; `src/lib/lightning.ts`, `resolveLightningAddress` and `fetchInvoice` |

The model bounds one quote or checkout, one aggregate cart availability result, one inventory result, and one Lightning or manual route. It abstracts amount calculations and buyer data. An invoice request can fail after order publication. Actual payment, relay visibility, stock reservation, direct order commands and seller management are outside the model.

TLC checked `PublishedOrderNeedsAvailableCart` in 82 states. Supply `Checkout-mutant.cfg` as the second argument and use pstack's `/statechart` to interpret the failing path. In a disposable checkout, bypass only the `quote.items.some((item) => item.unavailable)` guard. The local fixture catches a discontinued item entering the manual publication path. Restore and rerun before advancing the reviewed commit.
