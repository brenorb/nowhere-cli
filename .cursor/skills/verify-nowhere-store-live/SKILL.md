---
name: verify-nowhere-store-live
description: Check live order receipt retrieval, seller filtering, inventory status and timestamp pagination when changing Nowhere store commands.
---

# Verify seller orders and inventory status

Order publication encrypts an order for the seller, publishes an event, and constructs a receipt containing that event. Seller retrieval decrypts candidates and filters by store, duplicate order ID and requested IDs. Inventory retrieval requests status from the store seller and exposes a decoded payload when it matches the expected shape.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-store-live
sh scripts/check-cli-state-machine.sh "$skill/OrderView.tla"
sh scripts/check-cli-state-machine.sh "$skill/Inventory.tla"
pnpm exec vitest run tests/e2e/store-live.test.ts
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Main adds bounded HTTP requests for historical rates. The modeled relay and filtering behavior is present at both refs.

| Transition | Source in `src/lib/store-live.ts` |
| --- | --- |
| Resolve context and relays, encrypt and publish order, construct receipt | `resolveStoreContext`, `publishOrderReceipt` |
| Resolve credentials, page through relay events and decrypt | `fetchOrdersForSeller`, `fetchOrdersByIds`, `fetchEventsPaginated`, `decryptOrderEventWithAccess` |
| Verify stored order, receipt or event against store details and rates | `verifyStoreOrderPayload`, `verifyStoreOrder`, `parseOrderPayload`, `getHistoricalRate` |
| Prepare signed inventory status and publish | `publishStoreStatus` |
| Query seller and store tags, decode status or return unavailable | `fetchCurrentStatus`, `deriveInventoryKeypair`, `isStatusPayload` |

The order-view model bounds a single candidate, with previous acceptance of its ID and filter matching represented as inputs. The inventory model assumes the relay respects the author query. It does not assert that `publishStoreStatus` rejects a different local signing key. Both models abstract key selection, encryption, relay response, cryptographic verification, and payload shape. Checkout and local order overlays are in separate skills.

TLC checked seller filtering in 96 states and inventory filtering in 18 states. In a disposable checkout, run `python3 "$skill/references/extend-live-tests.py"` to add two in-memory relay cases. All eight store-live tests passed with those cases. Bypassing the store comparison in `fetchOrdersForSeller` makes the cross-store fixture fail. Removing the author constraint from `fetchCurrentStatus` makes the other-author inventory case fail. The matching mutant configs detect each change. [Seller orders statechart](../../../docs/statecharts/seller-orders.md)

## Existing pagination gap

```sh
sh scripts/check-cli-state-machine.sh "$skill/OrderPages.tla"
```

`EveryOrderFetched` fails when a relay caps a page within events sharing a timestamp. The next cursor is the oldest returned timestamp minus one. This skips the other tied order. The added fixture publishes three order events to an in-memory relay capped at one per request. Two share a timestamp. Seller retrieval returns only two events. Pstack shows the missed tied event after one newer page, one older page and one empty result. Restore disposable edits and rerun all checks when changing the order filters or pagination. Update the reviewed refs and expected outcomes.
