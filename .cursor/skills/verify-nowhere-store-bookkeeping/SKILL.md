---
name: verify-nowhere-store-bookkeeping
description: Verify the order status overlay, reconciliation, and concurrent writes when changing Nowhere local store management.
---

# Verify local store bookkeeping

A seller can change order status, mark confirmation, hide an order, or attach a note. Confirmation is a separate flag. It promotes a new order to confirmed and preserves any existing status. Reconciliation confirms only IDs that match known orders.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-store-bookkeeping
sh scripts/check-cli-state-machine.sh "$skill/Overlay.tla"
node --import tsx "$skill/references/check-bookkeeping.mjs"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'store manage commands persist'
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Both use the same order rules and read-modify-write sequence. Main publishes through a private temporary file and rejects malformed state. The tag writes directly and treats unreadable state as empty.

| Transition | Source in `src/lib/store-manage-state.ts` |
| --- | --- |
| Load, normalize and replace the local snapshot | `readState`, `normalizeRecord`, `updateStoreRecord`, `writeState` |
| Read or explicitly change the status and overlays | `getStoreOrderOverlay`, `setStoreOrderStatus` |
| Mark or clear confirmation, independently of hiding and notes | `confirmStoreOrders`, `unconfirmStoreOrders`, `hideStoreOrders`, `unhideStoreOrders`, `setStoreOrderNote` |
| Extract IDs, separate known from missing, and confirm matches | `extractOrderIdsFromText`, `reconcileStoreOrders` |

The overlay model covers one order with six statuses, a confirmation flag, a hide flag and note presence. The write model bounds two concurrent updates to distinct fields of one order. It assumes both writes complete and omits JSON encoding, path resolution and read or write failures. The source fixture also checks normalized IDs and reconciliation.

TLC checked `ConfirmationKeepsExistingStatus` in 48 states. `Overlay-mutant.cfg` allows confirmation to reset a fulfilled order. In a disposable checkout, force the status assignment branch in `confirmStoreOrders`; the source fixture detects the change.

## Existing concurrent-write gap

```sh
sh scripts/check-cli-state-machine.sh "$skill/OverlayWrites.tla"
sh scripts/check-cli-state-machine.sh "$skill/OverlayWrites.tla" "$skill/OverlayWrites-merge.cfg"
```

`AcknowledgedUpdatesPersist` fails under the current sequence. Both calls read the old file, each modifies its own snapshot, and the second commit overwrites the first. The local fixture ran a hide and a note concurrently. Both operations returned success, but the reread showed only one change. The 13-state merge config represents an atomic merge of distinct updates. Recheck the model and fixture when changing local persistence, then update the reviewed refs and expected outcomes.
